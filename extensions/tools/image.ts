/**
 * maas_generate_image — 文生图（POST /api/v3/images，异步任务）
 *
 * 接口约定：
 * - 仅支持 application/json，不允许未知字段
 * - 模型可用 body model 或请求头 x-ai-eg-model 指定（二选一，同给必须一致）
 * - 单次 1-10 张按张计费；结果在 data.images[]（index + url），URL 24h 有效
 * - stream=true / partial_images≠0 返回 400（异步接口不支持）
 */

import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { MaasConfig } from "../config.ts";
import { resolveOutputDir } from "../config.ts";
import { maasRequest, MaasError, resolveModel } from "../api.ts";
import { downloadFile, pollTask } from "../tasks.ts";

export interface ImageToolDetails {
	task_id: string;
	model: string;
	status: string;
	files: { path: string; bytes: number }[];
	urls: string[];
	elapsedMs: number;
}

const ImageParams = Type.Object({
	prompt: Type.String({ description: "文生图提示词，不能为空" }),
	model: Type.Optional(
		Type.String({
			description:
				"模型 ID，固定为 Qwen-Image-2.1（文生图+编辑一体）。缺省时自动匹配",
		}),
	),
	n: Type.Optional(Type.Number({ description: "输出张数 1-10，按张计费", default: 1 })),
	size: Type.Optional(
		Type.String({ description: "输出尺寸，如 1024x1024 / 1536x1024 / 1024x1536 或 auto" }),
	),
	quality: Type.Optional(Type.String({ description: "画质档位（由模型决定实际支持值）" })),
	style: Type.Optional(Type.String({ description: "风格，仅部分模型支持" })),
	output_format: Type.Optional(
		Type.String({ description: "输出格式 png/jpeg/webp", default: "png" }),
	),
	output_dir: Type.Optional(
		Type.String({ description: "产物保存目录（默认 ~/.pi/media/images）" }),
	),
});

export function createGenerateImageTool(pi: ExtensionAPI, getConfig: () => MaasConfig) {
	pi.registerTool<typeof ImageParams, ImageToolDetails>({
		name: "maas_generate_image",
		label: "生成图片",
		description:
			"通过源力 MaaS 平台提交文生图任务（异步）。提交后自动轮询直至完成，产物下载保存到本地并以内嵌图片返回。" +
			"典型耗时 10-60 秒。失败任务不计费。",
		promptSnippet: "用源力 MaaS 文生图（qwen-image 系列）生成图片并保存到本地",
		promptGuidelines: [
			"maas_generate_image 是异步任务：调用后自动等待完成并返回本地文件路径，无需手动轮询",
			"修改已有图片请用 maas_edit_image 而不是重新生成",
			"视频在途任务超过 2 个会被限流（429），生成视频时避免并发多个任务",
		],
		parameters: ImageParams,
		execute: async (_id, params, signal, onUpdate): Promise<AgentToolResult<ImageToolDetails>> => {
			const cfg = getConfig();
			const model = await resolveModel(cfg, params.model, ["qwen-image"]);
			const body: Record<string, unknown> = {
				model,
				prompt: params.prompt,
				n: params.n ?? 1,
				output_format: params.output_format ?? "png",
				output_compression: undefined,
			};
			if (params.size) body.size = params.size;
			if (params.quality) body.quality = params.quality;
			if (params.style) body.style = params.style;

			onUpdate?.({
				content: [{ type: "text", text: `提交文生图任务（模型 ${model}）…` }],
				details: { task_id: "", model, status: "submitting", files: [], urls: [], elapsedMs: 0 },
			});

			const createRes = await maasRequest(cfg, "/api/v3/images", {
				method: "POST",
				body,
				headers: { "x-ai-eg-model": model },
			});
			const taskId = createRes.body?.data?.id;
			if (!taskId) throw new MaasError("创建任务未返回 data.id", 500, createRes.body);

			const result = await pollTask(cfg, "image-gen", taskId, {
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
					`文生图任务失败: ${err?.code || ""} ${err?.message || "unknown"}（失败任务不计费）`,
					500,
					result.body,
				);
			}
			if (result.status === "cancelled") {
				throw new MaasError(`文生图任务已被取消`, 409, result.body);
			}

			// 下载落盘（URL 24h 有效）
			const ext = params.output_format ?? "png";
			const outDir = resolveOutputDir(cfg, "images", params.output_dir);
			const files: { path: string; bytes: number }[] = [];
			for (let i = 0; i < result.info.urls.length; i++) {
				const dest = join(outDir, `${taskId}_${i}.${ext}`);
				files.push(await downloadFile(result.info.urls[i], dest, signal));
			}

			// 内嵌图片返回给模型（上限 4 张，避免撑爆上下文）
			const content: AgentToolResult["content"] = [
				{
					type: "text",
					text:
						`文生图完成（task_id: ${taskId}，模型 ${model}，耗时 ${Math.round(result.elapsedMs / 1000)}s）。\n` +
						files.map((f) => `已保存: ${f.path} (${Math.round(f.bytes / 1024)} KB)`).join("\n"),
				},
				...files.slice(0, 4).map((f) => ({
					// eslint-disable-next-line @typescript-eslint/no-var-requires
					type: "image" as const,
					data: require("node:fs").readFileSync(f.path).toString("base64"),
					mimeType:
						ext === "jpg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png",
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
