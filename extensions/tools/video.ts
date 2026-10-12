/**
 * maas_generate_video — 视频生成（POST /api/v3/videos，异步任务）
 *
 * 接口约定：
 * - 必填 model + prompt；duration_seconds 4-15（默认 6，24fps）；resolution 仅 768P
 * - ratio 默认 16:9；adaptive 仅图生视频（纯文生传 adaptive 返回 422）
 * - 首/尾帧参考图：Data URI（data:image/png;base64,...）或公网 URL
 * - 结果在 task.content.results[0].url（旧 data.video_url 已废弃），链接 1h 有效
 * - 在途任务 > 2 返回 429 → 插件内自动退避重试
 * - queued 可取消不计费；running 不可取消（409）
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { MaasConfig } from "../config.ts";
import { resolveOutputDir } from "../config.ts";
import { maasRequest, MaasError, resolveModel } from "../api.ts";
import { downloadFile, pollTask, sleep } from "../tasks.ts";

export interface VideoToolDetails {
	task_id: string;
	model: string;
	status: string;
	file?: string;
	url?: string;
	elapsedMs: number;
}

const VideoParams = Type.Object({
	prompt: Type.String({
		description: "提示词，推荐「场景+主体+动作+运镜+风格」五要素写法",
	}),
	model: Type.Optional(Type.String({ description: "模型 ID，默认 minimax-h3" })),
	duration_seconds: Type.Optional(
		Type.Number({ description: "视频时长（秒），4-15 整数，默认 6", default: 6 }),
	),
	resolution: Type.Optional(Type.String({ description: "分辨率档位，当前仅 768P", default: "768P" })),
	ratio: Type.Optional(
		Type.String({ description: "画面比例，默认 16:9；adaptive 仅图生视频", default: "16:9" }),
	),
	num_inference_steps: Type.Optional(
		Type.Number({ description: "去噪步数（画质档），默认 50，速度优先可降至 8-12", default: 50 }),
	),
	seed: Type.Optional(Type.Number({ description: "随机种子（0 = 随机）" })),
	input_reference: Type.Optional(
		Type.String({ description: "首帧图片：本地文件路径（自动转 Data URI）或公网 URL" }),
	),
	last_frame_reference: Type.Optional(
		Type.String({ description: "尾帧图片：本地文件路径或 URL；需与首帧宽高比一致" }),
	),
	output_dir: Type.Optional(
		Type.String({ description: "产物保存目录（默认 ~/.pi/media/videos）" }),
	),
});

/** 本地路径 → Data URI；URL 原样 */
async function toFrameRef(src: string): Promise<string> {
	if (/^https?:\/\//i.test(src) || src.startsWith("data:")) return src;
	const path = src.startsWith("~/") ? join(process.env.HOME || "", src.slice(2)) : src;
	const buf = await readFile(path).catch(() => {
		throw new MaasError(`参考帧图片不存在或不可读: ${path}`, 400, undefined);
	});
	return `data:image/png;base64,${buf.toString("base64")}`;
}

export function createGenerateVideoTool(pi: ExtensionAPI, getConfig: () => MaasConfig) {
	pi.registerTool<typeof VideoParams, VideoToolDetails>({
		name: "maas_generate_video",
		label: "生成视频",
		description:
			"通过Origin Power MaaS 平台提交视频生成任务（异步，MiniMax-h3）。提交后自动轮询直至完成（典型 1-5 分钟），" +
			"产物下载保存到本地并返回文件路径。支持首/尾帧参考图（图生视频）。在途任务超过 2 个会被限流，插件内自动退避重试。",
		promptSnippet: "用Origin Power MaaS 生成视频（minimax-h3，最长 15 秒 768P）",
		promptGuidelines: [
			"视频生成耗时较长（1-5 分钟），工具会自动轮询等待，无需手动查询",
			"同平台在途视频任务超过 2 个会 429，不要并发提交多个视频任务",
			"图生视频把首帧图片本地路径传 input_reference；纯文生视频不要传 adaptive 比例",
		],
		parameters: VideoParams,
		execute: async (_id, params, signal, onUpdate): Promise<AgentToolResult<VideoToolDetails>> => {
			const cfg = getConfig();
			const model = await resolveModel(cfg, params.model, ["minimax", "video"]);
			const duration = params.duration_seconds ?? 6;
			if (duration < 4 || duration > 15 || !Number.isInteger(duration)) {
				throw new MaasError("duration_seconds 需为 4-15 的整数", 422, undefined);
			}
			const body: Record<string, unknown> = {
				model,
				prompt: params.prompt,
				duration_seconds: duration,
				resolution: (params.resolution || "768P").toUpperCase(),
				ratio: params.ratio || "16:9",
				num_inference_steps: params.num_inference_steps ?? 50,
			};
			if (params.seed !== undefined) body.seed = params.seed;
			if (params.input_reference) body.input_reference = await toFrameRef(params.input_reference);
			if (params.last_frame_reference)
				body.last_frame_reference = await toFrameRef(params.last_frame_reference);

			onUpdate?.({
				content: [{ type: "text", text: `提交视频生成任务（模型 ${model}，${duration}s）…` }],
				details: { task_id: "", model, status: "submitting", elapsedMs: 0 },
			});

			// 429 退避重试（在途任务 >2 或限流）
			let createRes;
			for (let attempt = 0; ; attempt++) {
				try {
					createRes = await maasRequest(cfg, "/api/v3/videos", { method: "POST", body });
					break;
				} catch (e: any) {
					if (e instanceof MaasError && e.status === 429 && attempt < 2) {
						onUpdate?.({
							content: [{ type: "text", text: `在途任务已满，${30}s 后重试（第 ${attempt + 1}/2 次）…` }],
							details: { task_id: "", model, status: "retrying", elapsedMs: 0 },
						});
						await sleep(30_000, signal);
						continue;
					}
					throw e;
				}
			}
			const taskId = createRes!.body?.data?.id;
			if (!taskId) throw new MaasError("创建任务未返回 data.id", 500, createRes!.body);

			const result = await pollTask(cfg, "video", taskId, {
				signal,
				intervalMs: 6_000,
				timeoutMs: 15 * 60_000,
				onUpdate: (status, elapsed) =>
					onUpdate?.({
						content: [
							{ type: "text", text: `任务 ${taskId} 状态: ${status}（已等待 ${Math.round(elapsed / 1000)}s）` },
						],
						details: { task_id: taskId, model, status, elapsedMs: elapsed },
					}),
			});

			if (result.status === "failed") {
				const err = result.info.error;
				throw new MaasError(
					`视频任务失败: ${err?.code || err?.message || "unknown"}${err?.message?.includes("cancelled") ? "（排队中取消不计费）" : ""}`,
					500,
					result.body,
				);
			}
			if (result.status === "cancelled") {
				throw new MaasError(`视频任务已被取消`, 409, result.body);
			}

			const url = result.info.urls[0];
			if (!url) throw new MaasError("任务成功但未返回下载链接", 500, result.body);
			const outDir = resolveOutputDir(cfg, "videos", params.output_dir);
			const file = await downloadFile(url, join(outDir, `${taskId}.mp4`), signal);

			return {
				content: [
					{
						type: "text",
						text:
							`视频生成完成（task_id: ${taskId}，模型 ${model}，耗时 ${Math.round(result.elapsedMs / 1000)}s）。\n` +
							`已保存: ${file.path} (${Math.round(file.bytes / 1024 / 1024 * 10) / 10} MB)`,
					},
				],
				details: { task_id: taskId, model, status: result.status, file: file.path, url, elapsedMs: result.elapsedMs },
			};
		},
	});
}
