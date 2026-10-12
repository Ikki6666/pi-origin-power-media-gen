/**
 * maas_generate_music — 文生音乐（POST /api/v3/musics，异步任务）
 *
 * 接口约定：
 * - 模型固定 MiniMax-Music3，输出 WAV（32000Hz/16bit/立体声），生成约 4-6 倍实时
 * - 必填 input（歌词，模型逐字演唱原文，不代写）+ instructions（风格描述，非空）
 * - input 支持段落结构标签：[Intro] [Verse] [Pre Chorus] [Chorus] [Bridge] [Outro] [Inst] 等
 * - max_new_tokens 是时长上限而非目标（25 token ≈ 1 秒，默认 3000 ≈ 2 分钟）
 * - ⚠️ 产物字段沿用 video_url 但值是 WAV 音频直链（插件内重命名为 audio_url）
 * - 状态枚举 queued/processing/completed/failed（与其他任务不同，插件内归一化）
 */

import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { MaasConfig } from "../config.ts";
import { resolveOutputDir } from "../config.ts";
import { maasRequest, MaasError } from "../api.ts";
import { downloadFile, pollTask } from "../tasks.ts";

export interface MusicToolDetails {
	task_id: string;
	status: string;
	file?: string;
	audio_url?: string;
	elapsedMs: number;
}

const MusicParams = Type.Object({
	input: Type.String({
		description:
			"歌词（模型逐字演唱原文，不代写）。支持段落标签 [Intro]/[Verse]/[Chorus]/[Bridge]/[Outro] 等；纯音乐用 [Inst]",
	}),
	instructions: Type.String({
		description: "风格描述，非空，如「流行,女声,钢琴,温暖的,中速」；无人声伴奏也在此写明",
	}),
	max_new_tokens: Type.Optional(
		Type.Number({
			description: "时长上限 token 数（25 token ≈ 1 秒），是上限而非目标；默认 3000（约 2 分钟）",
			default: 3000,
		}),
	),
	seed: Type.Optional(Type.Number({ description: "随机种子（0 = 随机）" })),
	output_dir: Type.Optional(
		Type.String({ description: "产物保存目录（默认 ~/.pi/media/musics）" }),
	),
});

export function createGenerateMusicTool(pi: ExtensionAPI, getConfig: () => MaasConfig) {
	pi.registerTool<typeof MusicParams, MusicToolDetails>({
		name: "maas_generate_music",
		label: "生成音乐",
		description:
			"通过源力 MaaS 平台提交文生音乐任务（MiniMax-Music3，输出 WAV）。歌词必须由调用方提供（模型逐字演唱原文），" +
			"想要自动出词先用对话模型生成歌词再传入。提交后自动轮询直至完成，音频下载保存到本地并返回路径。",
		promptSnippet: "用源力 MaaS 生成音乐（MiniMax-Music3，需提供歌词）",
		promptGuidelines: [
			"maas_generate_music 的 input 是歌词本身，模型不代写；用户没有给歌词时先用对话模型写好再传入",
			"instructions 必填且非空（如「流行,女声,钢琴,温暖的,中速」），空字符串会被拒绝",
			"音乐生成约 4-6 倍实时速度，2 分钟的歌约需 30 秒，工具会自动轮询等待",
		],
		parameters: MusicParams,
		execute: async (_id, params, signal, onUpdate): Promise<AgentToolResult<MusicToolDetails>> => {
			const cfg = getConfig();
			if (!params.input.trim()) throw new MaasError("input（歌词）不能为空", 422, undefined);
			if (!params.instructions.trim())
				throw new MaasError("instructions（风格描述）不能为空字符串", 422, undefined);

			onUpdate?.({
				content: [{ type: "text", text: "提交音乐生成任务（MiniMax-Music3）…" }],
				details: { task_id: "", status: "submitting", elapsedMs: 0 },
			});

			const body: Record<string, unknown> = {
				model: "MiniMax-Music3",
				input: params.input,
				instructions: params.instructions,
				max_new_tokens: params.max_new_tokens ?? 3000,
			};
			if (params.seed !== undefined) body.seed = params.seed;

			const createRes = await maasRequest(cfg, "/api/v3/musics", { method: "POST", body });
			const taskId = createRes.body?.data?.id;
			if (!taskId) throw new MaasError("创建任务未返回 data.id", 500, createRes.body);

			const result = await pollTask(cfg, "music", taskId, {
				signal,
				intervalMs: 6_000,
				timeoutMs: 10 * 60_000,
				onUpdate: (status, elapsed) =>
					onUpdate?.({
						content: [
							{ type: "text", text: `任务 ${taskId} 状态: ${status}（已等待 ${Math.round(elapsed / 1000)}s）` },
						],
						details: { task_id: taskId, status, elapsedMs: elapsed },
					}),
			});

			if (result.status === "failed") {
				const err = result.info.error;
				throw new MaasError(
					`音乐任务失败: ${err?.code || err?.message || "unknown"}（失败自动退费）`,
					500,
					result.body,
				);
			}
			if (result.status === "cancelled") {
				throw new MaasError(`音乐任务已被取消`, 409, result.body);
			}

			const audioUrl = result.info.audioUrl || result.info.urls[0];
			if (!audioUrl) throw new MaasError("任务成功但未返回音频链接", 500, result.body);
			const outDir = resolveOutputDir(cfg, "musics", params.output_dir);
			const file = await downloadFile(audioUrl, join(outDir, `${taskId}.wav`), signal);

			return {
				content: [
					{
						type: "text",
						text:
							`音乐生成完成（task_id: ${taskId}，耗时 ${Math.round(result.elapsedMs / 1000)}s）。\n` +
							`已保存: ${file.path} (${Math.round(file.bytes / 1024 / 1024 * 10) / 10} MB，WAV)`,
					},
				],
				details: {
					task_id: taskId,
					status: result.status,
					file: file.path,
					audio_url: audioUrl,
					elapsedMs: result.elapsedMs,
				},
			};
		},
	});
}
