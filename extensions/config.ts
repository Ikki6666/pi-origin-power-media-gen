/**
 * 源力媒体生成扩展配置（源力 MaaS 多模态：图片/视频/音乐）
 *
 * 环境变量：
 *   YUANLI_BASE_URL  网关地址（默认 http://api.dev.origin-power.com）
 *   YUANLI_API_KEY   鉴权 Key（未设置时回退 AGW_API_KEY）
 *   YUANLI_MEDIA_DIR 产物根目录（默认 ~/.pi/media）
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface MaasConfig {
	baseUrl: string;
	apiKey: string | undefined;
	mediaDir: string;
}

export function loadConfig(): MaasConfig {
	const env = process.env;
	return {
		baseUrl: (env.YUANLI_BASE_URL || "http://api.dev.origin-power.com").replace(/\/+$/, ""),
		apiKey: env.YUANLI_API_KEY || env.AGW_API_KEY,
		mediaDir: expandTilde(env.YUANLI_MEDIA_DIR || join(homedir(), ".pi", "media")),
	};
}

/** 本扩展支持的多模态模型（/maas 仅显示这些；工具调用仅接受这些） */
export const SUPPORTED_MODELS = [
	"Qwen-Image-2.1",
	"minimax-h3",
	"MiniMax-Music3",
] as const;

/** 展开 ~ 开头的路径 */
export function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

/**
 * 解析产物输出目录。
 * 优先级：调用参数 output_dir > YUANLI_MEDIA_DIR 子目录 > 默认 ~/.pi/media/<subdir>
 */
export function resolveOutputDir(cfg: MaasConfig, subdir: string, custom?: string): string {
	return custom ? expandTilde(custom) : join(cfg.mediaDir, subdir);
}
