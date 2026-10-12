/**
 * 异步任务引擎：轮询 / 取消 / 产物下载落盘
 *
 * 源力 MaaS 任务接口约定（来自 Apifox 项目 8900609）：
 * - 创建任务返回 202 + data.id（前缀 image_/video_/music_ + 24 位十六进制）
 * - 状态枚举：图片/视频 queued/running/succeeded/failed/cancelled；
 *   音乐 queued/processing/completed/failed（completed 归一化为 succeeded）
 * - 结果 URL 为预签名直链：图片 24h 有效，视频/音乐 1h 有效，必须及时下载落盘
 * - 音乐产物字段沿用 video_url 但值是 WAV 音频
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MaasConfig } from "./config.ts";
import { maasRequest, MaasError } from "./api.ts";

export type TaskKind = "image-gen" | "image-edit" | "video" | "music";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function taskQueryPath(kind: TaskKind, taskId: string): string {
	switch (kind) {
		case "image-gen":
			return `/api/v3/images/tasks/${taskId}`;
		case "image-edit":
			return `/api/v3/images/edits/tasks/${taskId}`;
		case "video":
			return `/api/v3/videos/${taskId}`;
		case "music":
			return `/api/v3/musics/${taskId}`;
	}
}

/** 从任意任务响应中提取状态字段（响应结构因任务类型而异） */
export function extractStatus(body: any): string | undefined {
	return body?.status ?? body?.data?.status ?? body?.task?.status;
}

/** 归一化状态：音乐 completed → succeeded，processing → running */
export function normalizeStatus(raw: string): string {
	switch (raw) {
		case "completed":
			return "succeeded";
		case "processing":
			return "running";
		default:
			return raw;
	}
}

export interface TaskResultInfo {
	urls: string[];
	audioUrl?: string; // 音乐任务：video_url 字段（WAV 音频）
	error?: { code?: string; message?: string };
}

/** 按任务类型提取结果 */
export function extractResults(kind: TaskKind, body: any): TaskResultInfo {
	if (kind === "video") {
		const task = body?.task;
		const urls = (task?.content?.results || []).map((r: any) => r?.url).filter(Boolean);
		const fallback = body?.data?.video_url || body?.video_url;
		if (!urls.length && fallback) urls.push(fallback);
		return { urls, error: task?.error };
	}
	if (kind === "music") {
		// 文档写 video_url，实测网关返回统一的 task.content.results[].url（.wav），兼容两种
		let urls = (body?.task?.content?.results || []).map((r: any) => r?.url).filter(Boolean);
		const legacy = body?.video_url || body?.data?.video_url;
		if (!urls.length && legacy) urls.push(legacy);
		return { urls, audioUrl: urls[0], error: body?.task?.error ?? body?.data?.error };
	}
	// image-gen / image-edit：文档写 data.images[]，实测（网关）返回 task.content.results[].url，兼容两种
	const images = body?.data?.images || [];
	let urls = images.map((im: any) => im?.url).filter(Boolean);
	if (!urls.length) {
		urls = (body?.task?.content?.results || []).map((r: any) => r?.url).filter(Boolean);
	}
	return {
		urls,
		error: body?.data?.error ?? body?.task?.error,
	};
}

export interface PollOptions {
	signal?: AbortSignal;
	onUpdate?: (status: string, elapsedMs: number) => void;
	intervalMs?: number;
	timeoutMs?: number;
}

export interface PollResult {
	taskId: string;
	kind: TaskKind;
	status: string;
	body: any;
	info: TaskResultInfo;
	elapsedMs: number;
}

/**
 * 轮询任务直至终态。
 * 遵循接口文档：轮询间隔 5-10 秒，不并发轰炸；拿到终态即停。
 */
export async function pollTask(
	cfg: MaasConfig,
	kind: TaskKind,
	taskId: string,
	opts: PollOptions = {},
): Promise<PollResult> {
	const intervalMs = opts.intervalMs ?? 6_000;
	const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
	const start = Date.now();
	for (;;) {
		const res = await maasRequest(cfg, taskQueryPath(kind, taskId), { timeoutMs: 30_000 });
		const status = normalizeStatus(extractStatus(res.body) || "unknown");
		opts.onUpdate?.(status, Date.now() - start);
		if (TERMINAL.has(status)) {
			return {
				taskId,
				kind,
				status,
				body: res.body,
				info: extractResults(kind, res.body),
				elapsedMs: Date.now() - start,
			};
		}
		if (Date.now() - start > timeoutMs) {
			throw new MaasError(
				`任务 ${taskId} 轮询超时（已等待 ${Math.round(timeoutMs / 1000)}s），当前状态 ${status}。任务仍在平台侧进行，可稍后用 maas_task_status 查询。`,
				504,
				undefined,
			);
		}
		await sleep(intervalMs, opts.signal);
	}
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(t);
			reject(new DOMException("Aborted", "AbortError"));
		});
	});
}

const MIME_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"video/mp4": "mp4",
};

/**
 * 下载产物到本地并返回路径（自动重试 3 次，应对存储域瞬断）。
 * 预签名链接会过期（图片 24h / 视频·音乐 1h），下载失败提示重新查询获取新链接。
 */
export async function downloadFile(
	url: string,
	destPath: string,
	signal?: AbortSignal,
): Promise<{ path: string; bytes: number }> {
	let res: Response;
	let lastErr: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			if (attempt > 0) await sleep(5_000 * attempt, signal);
			const timeout = AbortSignal.timeout(120_000);
			res = await fetch(url, {
				signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
			});
			lastErr = undefined;
			break;
		} catch (e: any) {
			lastErr = e;
			if (signal?.aborted) throw e;
		}
	}
	if (lastErr) {
		throw new MaasError(
			`产物下载失败（已重试 3 次）: ${lastErr instanceof Error ? lastErr.message : lastErr}。预签名链接可能已过期或存储服务暂不可达，请重新查询任务获取新链接。`,
			502,
			undefined,
		);
	}
	res = res!;
	if (!res.ok) {
		throw new MaasError(
			`产物下载失败 [${res.status}]。403 通常表示链接过期，请重新查询任务获取新链接。`,
			res.status,
			undefined,
		);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	await mkdir(dirname(destPath), { recursive: true });
	await writeFile(destPath, buf);
	return { path: destPath, bytes: buf.length };
}

/** 根据响应 Content-Type 推断文件扩展名 */
export function extFromContentType(res: any, fallback: string): string {
	const ct = String(res?.headers?.get?.("content-type") || "").split(";")[0];
	return MIME_EXT[ct] || fallback;
}

// ---------- 取消（四条路径不统一，全部封装在此） ----------

/**
 * 取消任务。返回可读结果说明。
 * - 文生图: DELETE /api/v3/images/tasks/{id}
 * - 图片编辑: DELETE /api/v3/images/edits/tasks/{id}
 * - 视频: DELETE /api/v3/videos/{id}（queued 200 可取消不计费；running 409 不可取消）
 * - 音乐/图片编辑共用: POST /api/v3/tasks/cancel {task_id}（202 受理，稍后查询为 failed 并退费）
 */
export async function cancelTask(
	cfg: MaasConfig,
	kind: TaskKind,
	taskId: string,
): Promise<string> {
	try {
		if (kind === "image-gen") {
			await maasRequest(cfg, `/api/v3/images/tasks/${taskId}`, { method: "DELETE" });
			return `取消成功，任务进入 cancelled 终态（记录保留，仍可查询）`;
		}
		if (kind === "video") {
			await maasRequest(cfg, `/api/v3/videos/${taskId}`, { method: "DELETE" });
			return `取消成功。queued 状态被取消的任务不计费（预扣自动退回），后续查询将返回 failed 终态`;
		}
		// image-edit 与 music：走共用取消接口；image-edit 也可走独立 DELETE，这里统一走共用接口
		await maasRequest(cfg, "/api/v3/tasks/cancel", { method: "POST", body: { task_id: taskId } });
		return `取消请求已受理（HTTP 202）。约 5-10 秒后查询任务即为 failed（cancelled by user via API），计费自动解冻退费`;
	} catch (e: any) {
		if (e instanceof MaasError) {
			if (e.status === 400) throw new MaasError("任务已到终态，不可取消", 400, e.body);
			if (e.status === 403) throw new MaasError("只能取消自己 API Key 提交的任务", 403, e.body);
			if (e.status === 404) throw new MaasError("任务不存在", 404, e.body);
			if (e.status === 409)
				throw new MaasError(
					"任务不可取消：生成中的任务会正常完成并计费，或任务已到终态",
					409,
					e.body,
				);
		}
		throw e;
	}
}

/** 从 task_id 前缀推断任务类型 */
export function guessKind(taskId: string): TaskKind | undefined {
	if (taskId.startsWith("video_")) return "video";
	if (taskId.startsWith("music_")) return "music";
	if (taskId.startsWith("image_")) return "image-gen"; // image_ 前缀文生图/编辑共用，调用方可用 kind 覆盖
	return undefined;
}
