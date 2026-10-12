/**
 * 源力媒体生成扩展（源力 MaaS 多模态：图片 / 视频 / 音乐）— Pi Extension
 *
 * 通过源力 MaaS 平台（http://api.dev.origin-power.com）给 Pi 加多模态生成能力：
 *   maas_generate_image   文生图（Qwen-Image-2.1-Turbo）
 *   maas_edit_image       图片编辑（Qwen-Image-2.1-Turbo）
 *   maas_generate_video   视频生成（MiniMax-h3）
 *   maas_generate_music   音乐生成（MiniMax-Music3）
 *   maas_task_status      任务状态查询 / 取消
 *
 * 配置见 config.ts（环境变量 YUANLI_BASE_URL / YUANLI_API_KEY / YUANLI_MEDIA_DIR）。
 * 另提供 /origin-power-media-gen 命令查看当前配置与可用模型。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, type MaasConfig } from "./config.ts";
import { listModels } from "./api.ts";
import { createGenerateImageTool } from "./tools/image.ts";
import { createEditImageTool } from "./tools/imageEdit.ts";
import { createGenerateVideoTool } from "./tools/video.ts";
import { createGenerateMusicTool } from "./tools/music.ts";
import { createTaskStatusTool } from "./tools/taskStatus.ts";

export default function (pi: ExtensionAPI) {
	// 配置快照：扩展加载时读取环境变量；reload 后重建
	const config: MaasConfig = loadConfig();
	const getConfig = () => config;

	// 不在工厂内发起网络请求（生命周期合规）；未配置 Key 时工具执行时会给出明确指引
	createGenerateImageTool(pi, getConfig);
	createEditImageTool(pi, getConfig);
	createGenerateVideoTool(pi, getConfig);
	createGenerateMusicTool(pi, getConfig);
	createTaskStatusTool(pi, getConfig);

	pi.registerCommand("origin-power-media-gen", {
		description: "查看源力媒体生成扩展配置与可用模型（图片/视频/音乐生成）",
		handler: async (_name, ctx) => {
			if (!config.apiKey) {
				ctx.ui.notify(
					"源力 MaaS：未配置 API Key。请设置环境变量 YUANLI_API_KEY 后重启 Pi。",
					"warning",
				);
				return;
			}
			try {
				const models = await listModels(config);
				const visible = models.filter((m) => config.supportedModels.includes(m));
				ctx.ui.notify(
					[
						`源力媒体生成扩展（图片/视频/音乐，源力 MaaS）`,
						`网关: ${config.baseUrl}`,
						`产物目录: ${config.mediaDir}`,
						`模型白名单 (${visible.length}${config.modelsFromEnv ? "，来自 YUANLI_MODELS 环境变量" : "，内置默认"}):`,
						...visible.map((m) => `  - ${m}`),
					].join("\n"),
					"info",
				);
			} catch (e: any) {
				ctx.ui.notify(`源力 MaaS：获取模型列表失败 - ${e.message}`, "warning");
			}
		},
	});
}
