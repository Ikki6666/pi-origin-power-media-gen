/**
 * 源力 MaaS HTTP 客户端
 * - Bearer 鉴权
 * - 统一错误结构 {type, error, request_id} 映射为可读文案
 * - /v1/models 列表缓存 + 模型 ID 校验
 */

import type { MaasConfig } from "./config.ts";
import { SUPPORTED_MODELS } from "./config.ts";

export class MaasError extends Error {
	status: number;
	body: unknown;
	constructor(message: string, status: number, body: unknown) {
		super(message);
		this.name = "MaasError";
		this.status = status;
		this.body = body;
	}
}

const STATUS_HINTS: Record<number, string> = {
	400: "参数缺失/非法/含未知字段",
	401: "API Key 缺失或无效",
	402: "账户余额不足，任务未创建",
	403: "内容审核不通过，或无权操作该任务",
	404: "资源不存在/已过期/不属于当前 Key",
	409: "任务状态冲突（如生成中或终态不可取消）",
	413: "请求体或字段值超限",
	415: "Content-Type 不受支持",
	422: "参数取值非法",
	429: "请求过于频繁或在途任务数超限",
	500: "任务服务内部错误",
	503: "模型无可用路由或依赖服务不可用",
};

export interface MaasResponse<T = any> {
	status: number;
	body: T;
	text: string;
}

export function requireApiKey(cfg: MaasConfig): string {
	if (!cfg.apiKey) {
		throw new MaasError(
			"未配置源力 MaaS API Key。请设置环境变量 YUANLI_API_KEY 后重启 Pi。",
			401,
			undefined,
		);
	}
	return cfg.apiKey;
}

export async function maasRequest<T = any>(
	cfg: MaasConfig,
	path: string,
	opts: {
		method?: string;
		body?: unknown;
		headers?: Record<string, string>;
		timeoutMs?: number;
	} = {},
): Promise<MaasResponse<T>> {
	const token = requireApiKey(cfg);
	const res = await fetch(`${cfg.baseUrl}${path}`, {
		method: opts.method || "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
			...opts.headers,
		},
		body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
		signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
	});
	const text = await res.text();
	let body: any = undefined;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {
		body = undefined;
	}
	if (res.status >= 400) {
		const apiMsg =
			body?.error?.message || body?.error || (typeof body?.message === "string" ? body.message : "");
		const hint = STATUS_HINTS[res.status] || "请求失败";
		const rid = body?.request_id ? ` (request_id: ${body.request_id})` : "";
		throw new MaasError(
			`MaaS 请求失败 [${res.status}] ${hint}${apiMsg ? `: ${apiMsg}` : ""}${rid}`,
			res.status,
			body ?? text.slice(0, 500),
		);
	}
	return { status: res.status, body: body as T, text };
}

// ---------- 模型列表（缓存 5 分钟） ----------

let modelsCache: { ids: string[]; at: number } | undefined;

export async function listModels(cfg: MaasConfig): Promise<string[]> {
	if (modelsCache && Date.now() - modelsCache.at < 5 * 60_000) return modelsCache.ids;
	const res = await maasRequest<{ data: { id: string }[] }>(cfg, "/v1/models");
	const ids = (res.body?.data || []).map((m) => m.id);
	modelsCache = { ids, at: Date.now() };
	return ids;
}

/** 校验模型 ID；model 缺省时按关键词自动挑选。仅接受 SUPPORTED_MODELS 内的模型 */
export async function resolveModel(
	cfg: MaasConfig,
	model: string | undefined,
	matchKeywords: string[],
): Promise<string> {
	const ids = await listModels(cfg);
	const supported = ids.filter((id) => (SUPPORTED_MODELS as readonly string[]).includes(id));
	if (model) {
		if (!(SUPPORTED_MODELS as readonly string[]).includes(model)) {
			throw new MaasError(
				`模型 "${model}" 不在本扩展支持范围内。支持的模型: ${SUPPORTED_MODELS.join(", ")}`,
				400,
				undefined,
			);
		}
		if (ids.length > 0 && !ids.includes(model)) {
			throw new MaasError(
				`模型 "${model}" 不在当前 Key 可访问列表中。可用模型: ${supported.join(", ")}。请调用 /maas 或以 /v1/models 返回的准确 ID 为准。`,
				400,
				undefined,
			);
		}
		return model;
	}
	const hit = supported.find((id) => matchKeywords.some((kw) => id.toLowerCase().includes(kw)));
	if (!hit) {
		throw new MaasError(
			`未指定 model 且无法自动匹配（关键词: ${matchKeywords.join("/")}）。支持的模型: ${SUPPORTED_MODELS.join(", ")}`,
			400,
			undefined,
		);
	}
	return hit;
}
