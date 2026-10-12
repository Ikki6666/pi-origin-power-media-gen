/**
 * maas_edit_image — 图片编辑（POST /api/v3/images/edits，异步任务）
 *
 * 接口约定：
 * - JSON 方式仅接受 http(s) URL 或纯 Base64（禁 data: 前缀、不支持 mask）
 * - 模型固定 Qwen-Image-2.1-Turbo（编辑参考图最多 4 张）
 * - 请求体 ≤100 MiB、单图 ≤50 MiB（Base64 编码后 ≤66.7 MiB）、prompt ≤32000 字符
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { MaasConfig } from "../config.ts";
import { resolveOutputDir } from "../config.ts";
import { maasRequest, MaasError, resolveModel } from "../api.ts";
import { downloadFile, pollTask } from "../tasks.ts";

export interface ImageEditToolDetails {
	task_id: string;
	model: string;
	status: string;
	files: { path: string; bytes: number }[];
	urls: string[];
	elapsedMs: number;
}

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/** 解析输入图片：http(s) URL 原样透传；本地路径读入转纯 Base64 */
async function resolveInputImage(src: string): Promise<string> {
	if (/^https?:\/\//i.test(src)) return src;
	const path = src.startsWith("~/") ? join(process.env.HOME || "", src.slice(2)) : src;
	const info = await stat(path).catch(() => {
		throw new MaasError(`输入图片不存在或不可读: ${path}`, 400, undefined);
	});
	if (info.size > MAX_IMAGE_BYTES) {
		throw new MaasError(
			`输入图片超过 50 MiB 限制: ${path} (${Math.round(info.size / 1024 / 1024)} MiB)`,
			413,
			undefined,
		);
	}
	return (await readFile(path)).toString("base64");
}

const ImageEditParams = Type.Object({
	images: Type.Array(Type.String(), {
		description: "输入图片：本地文件路径或 http(s) URL，1-4 张；顺序即输入顺序",
	}),
	prompt: Type.String({ description: "编辑指令：描述要在原图上做的修改" }),
	model: Type.Optional(
		Type.String({
			description:
				"模型 ID，固定为 Qwen-Image-2.1-Turbo（编辑参考图最多 4 张）",
		}),
	),
	n: Type.Optional(Type.Number({ description: "输出图片数量", default: 1 })),
	size: Type.Optional(Type.String({ description: "输出尺寸（如 1024x1024），缺省由模型决定" })),
	quality: Type.Optional(Type.String({ description: "画质档位" })),
	input_fidelity: Type.Optional(Type.String({ description: "输入保真度" })),
	output_format: Type.Optional(
		Type.String({ description: "输出格式 png/jpeg/webp", default: "png" }),
	),
	output_dir: Type.Optional(
		Type.String({ description: "产物保存目录（默认 ~/.pi/media/images）" }),
	),
});

export function createEditImageTool(pi: ExtensionAPI, getConfig: () => MaasConfig) {
	pi.registerTool<typeof ImageEditParams, ImageEditToolDetails>({
		name: "maas_edit_image",
		label: "编辑图片",
		description:
			"通过Origin Power MaaS 平台提交图片编辑任务（异步）：在原图上按指令修改。本地文件路径自动转 Base64 上传。" +
			"提交后自动轮询直至完成，产物下载保存到本地并以内嵌图片返回。",
		promptSnippet: "用Origin Power MaaS 编辑已有图片（Qwen-Image-2.1-Turbo）",
		promptGuidelines: [
			"修改用户提供的图片时优先用 maas_edit_image，把图片本地路径直接传入 images 参数",
			"输入图 1-4 张（Qwen-Image-2.1-Turbo 参考图最多 4 张）",
		],
		parameters: ImageEditParams,
		execute: async (_id, params, signal, onUpdate): Promise<AgentToolResult<ImageEditToolDetails>> => {
			const cfg = getConfig();
			if (params.images.length < 1 || params.images.length > 4) {
				throw new MaasError("输入图片数量需为 1-4 张", 400, undefined);
			}
			const model = await resolveModel(cfg, params.model, ["qwen-image"]);
			const resolved = await Promise.all(params.images.map(resolveInputImage));

			onUpdate?.({
				content: [{ type: "text", text: `提交图片编辑任务（模型 ${model}，${resolved.length} 张输入图）…` }],
				details: { task_id: "", model, status: "submitting", files: [], urls: [], elapsedMs: 0 },
			});

			const createRes = await maasRequest(cfg, "/api/v3/images/edits", {
				method: "POST",
				body: {
					model,
					images: resolved,
					prompt: params.prompt,
					n: params.n ?? 1,
					output_format: params.output_format ?? "png",
					...(params.size ? { size: params.size } : {}),
					...(params.quality ? { quality: params.quality } : {}),
					...(params.input_fidelity ? { input_fidelity: params.input_fidelity } : {}),
				},
			});
			const taskId = createRes.body?.data?.id;
			if (!taskId) throw new MaasError("创建任务未返回 data.id", 500, createRes.body);

			const result = await pollTask(cfg, "image-edit", taskId, {
				signal,
				onUpdate: (status) =>
					onUpdate?.({
						content: [{ type: "text", text: `任务 ${taskId} 状态: ${status}` }],
						details: { task_id: taskId, model, status, files: [], urls: [], elapsedMs: 0 },
					}),
			});

			if (result.status === "failed") {
				const err = result.info.error;
				throw new MaasError(
					`图片编辑任务失败: ${err?.code || ""} ${err?.message || "unknown"}（失败任务不计费）`,
					500,
					result.body,
				);
			}
			if (result.status === "cancelled") {
				throw new MaasError(`图片编辑任务已被取消`, 409, result.body);
			}

			const ext = params.output_format ?? "png";
			const outDir = resolveOutputDir(cfg, "images", params.output_dir);
			const files: { path: string; bytes: number }[] = [];
			for (let i = 0; i < result.info.urls.length; i++) {
				files.push(await downloadFile(result.info.urls[i], join(outDir, `${taskId}_${i}.${ext}`), signal));
			}

			const content: AgentToolResult["content"] = [
				{
					type: "text",
					text:
						`图片编辑完成（task_id: ${taskId}，模型 ${model}，耗时 ${Math.round(result.elapsedMs / 1000)}s）。\n` +
						files.map((f) => `已保存: ${f.path} (${Math.round(f.bytes / 1024)} KB)`).join("\n"),
				},
				...files.slice(0, 4).map((f) => ({
					type: "image" as const,
					data: require("node:fs").readFileSync(f.path).toString("base64"),
					mimeType: ext === "jpg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png",
				})),
			];

			return {
				content,
				details: {
					task_id: taskId,
					model,
					status: result.status,
					files,
					urls: result.info.urls,
					elapsedMs: result.elapsedMs,
				},
			};
		},
	});
}
