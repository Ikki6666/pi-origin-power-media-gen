/**
 * maas_task_status — 查询/取消任意 MaaS 任务
 *
 * 四条取消路径不统一，全部封装：
 * - 文生图: DELETE /api/v3/images/tasks/{id}
 * - 图片编辑: DELETE /api/v3/images/edits/tasks/{id}
 * - 视频: DELETE /api/v3/videos/{id}
 * - 音乐/图片编辑共用: POST /api/v3/tasks/cancel
 */

import { Type } from "typebox";
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { MaasConfig } from "../config.ts";
import { maasRequest, MaasError } from "../api.ts";
import { cancelTask, extractStatus, guessKind, normalizeStatus, type TaskKind } from "../tasks.ts";

export interface TaskStatusDetails {
	task_id: string;
	kind: TaskKind | "unknown";
	status: string;
	raw: unknown;
	cancelled: boolean;
}

const TaskStatusParams = Type.Object({
	task_id: Type.String({ description: "任务 ID（image_/video_/music_ 前缀）" }),
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("image"),
				Type.Literal("image-edit"),
				Type.Literal("video"),
				Type.Literal("music"),
			],
			{
				description:
					"任务类型；缺省时按 task_id 前缀自动推断。注意 image_ 前缀文生图/编辑共用，必要时显式指定",
			},
		),
	),
	cancel: Type.Optional(Type.Boolean({ description: "为 true 时取消该任务（仅 queued 可退费取消）" })),
});

export function createTaskStatusTool(pi: ExtensionAPI, getConfig: () => MaasConfig) {
	pi.registerTool<typeof TaskStatusParams, TaskStatusDetails>({
		name: "maas_task_status",
		label: "查询/取消 MaaS 任务",
		description:
			"查询源力 MaaS 异步任务（图片/视频/音乐）的当前状态，或取消任务。" +
			"通常不需要手动调用——maas_generate_* 工具已内置轮询；用于会话中断后恢复查询或取消排队中的任务。",
		parameters: TaskStatusParams,
		execute: async (_id, params): Promise<AgentToolResult<TaskStatusDetails>> => {
			const cfg = getConfig();
			const kind: TaskKind | undefined =
				params.kind === "image" ? "image-gen" : (params.kind as TaskKind) || guessKind(params.task_id);
			if (!kind) {
				throw new MaasError(
					`无法从 task_id "${params.task_id}" 推断任务类型，请通过 kind 参数显式指定`,
					400,
					undefined,
				);
			}

			let cancelNote = "";
			if (params.cancel) {
				cancelNote = await cancelTask(cfg, kind, params.task_id);
			}

			const queryPath =
				kind === "image-gen"
					? `/api/v3/images/tasks/${params.task_id}`
					: kind === "image-edit"
						? `/api/v3/images/edits/tasks/${params.task_id}`
						: kind === "video"
							? `/api/v3/videos/${params.task_id}`
							: `/api/v3/musics/${params.task_id}`;

			const res = await maasRequest(cfg, queryPath);
			const status = normalizeStatus(extractStatus(res.body) || "unknown");

			const statusNote =
				status === "queued"
					? "（排队中，计费预扣；queued 可取消且不计费）"
					: status === "running"
						? "（生成中，不可取消）"
						: status === "succeeded"
							? "（已完成）"
							: status === "failed"
								? "（已失败，不计费/自动退费）"
								: status === "cancelled"
									? "（已取消）"
									: "";

			return {
				content: [
					{
						type: "text",
						text:
							`任务 ${params.task_id}（${kind}）：${status}${statusNote}` +
							(cancelNote ? `\n${cancelNote}` : ""),
					},
				],
				details: {
					task_id: params.task_id,
					kind,
					status,
					raw: res.body,
					cancelled: Boolean(params.cancel),
				},
			};
		},
	});
}
