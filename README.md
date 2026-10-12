# 源力媒体生成扩展（Pi Extension）

通过源力 MaaS 平台给 Pi 加多模态生成能力：**文生图、图片编辑、视频生成、音乐生成**。工具名 `maas_*`，目录名即用途：`yuanli-media-gen`。

## 安装

```bash
# npm 发布后
pi install npm:pi-yuanli-media-gen@1.0.0

# 或从本地路径（开发/试用）
pi install /path/to/pi-yuanli-media-gen
```

## 工具清单

| 工具 | 说明 | 模型 |
|---|---|---|
| `maas_generate_image` | 文生图（异步任务，自动轮询） | Qwen-Image-2.1-Turbo |
| `maas_edit_image` | 图片编辑（本地文件自动转 Base64） | Qwen-Image-2.1-Turbo |
| `maas_generate_video` | 视频生成（支持首/尾帧参考图） | minimax-h3（最长 15s，768P） |
| `maas_generate_music` | 音乐生成（需提供歌词，模型逐字演唱） | MiniMax-Music3（WAV） |
| `maas_task_status` | 任务状态查询 / 取消（封装 4 条取消路径） | — |

所有生成工具均为异步任务制：插件内部自动轮询（终态即停）→ 产物下载落盘 → 返回本地路径。图片类工具额外以内嵌图片（ImageContent）返回给模型，可直接基于生成结果继续迭代。

**模型白名单**：`config.ts` 中的 `SUPPORTED_MODELS` 限定扩展仅接受 3 个多模态模型（`Qwen-Image-2.1-Turbo`（图片生成+编辑）、`minimax-h3`、`MiniMax-Music3`）；`/origin-power-media-gen` 命令仅显示这些模型，传入白名单外的模型直接拒绝。

## 配置（环境变量）

| 变量 | 说明 | 默认 |
|---|---|---|
| `YUANLI_API_KEY` | 鉴权 Key（未设置时回退 `AGW_API_KEY`） | — |
| `YUANLI_BASE_URL` | 网关地址 | `http://api.dev.origin-power.com` |
| `YUANLI_MEDIA_DIR` | 产物根目录 | `~/.pi/media` |
| `YUANLI_MODELS` | 模型白名单覆盖（逗号分隔，如 `Qwen-Image-2.1-Turbo,minimax-h3,MiniMax-Music3,qwen-image-2512`）；未设置时用内置默认 | 内置默认 |

产物目录优先级：**工具参数 `output_dir` > `YUANLI_MEDIA_DIR` > 默认**。产物按类型存放于 `images/`、`videos/`、`musics/` 子目录。

运行 `/origin-power-media-gen` 命令可查看当前配置与可用模型列表。

## 实测约定（与 Apifox 文档的差异，以实测为准）

- **统一任务响应结构**：所有任务查询返回 `task.{status, content.results[].url}`；文档中的 `data.images[]` / `video_url` 字段实际不出现（插件已做兼容）。
- **签名链接有效期**：图片 24h、视频/音乐 1h。产物**必须及时下载落盘**，链接过期重新查询即可获得新链接。插件默认已下载，无需关心。
- **模型校验是异步的**：网关对创建任务传入的无效模型 ID 返回 202（任务受理后在执行阶段失败）。插件在调用前会用 `/v1/models` 列表做客户端校验（缓存 5 分钟）。
- **取消路径不统一**：文生图 / 图片编辑 / 视频 / 音乐各有不同端点，已全部封装在 `maas_task_status` 的 `cancel` 参数内。
- **queued 取消不计费**：视频任务排队中取消不收费（预扣退回）；生成中不可取消（409）。

## 错误码映射

| HTTP | 含义 |
|---|---|
| 400 | 参数缺失/非法/含未知字段 |
| 401 | API Key 缺失或无效 |
| 402 | 账户余额不足 |
| 403 | 内容审核不通过 / 无权操作 |
| 404 | 任务不存在/过期/非本人 Key |
| 409 | 任务状态冲突（生成中/终态不可取消） |
| 413 | 请求体超限 |
| 422 | 参数取值非法 |
| 429 | 在途任务超限（视频 > 2 个自动退避重试） |
| 503 | 无可用路由 |

## 开发

- 目录结构：`index.ts`（入口）/ `config.ts` / `api.ts`（HTTP 客户端）/ `tasks.ts`（任务引擎）/ `tools/*.ts`
- 类型检查：`tsc -p tsconfig.json`（`node_modules` 软链指向 pi-coding-agent 的依赖）
- 热加载测试：`pi --extension ./index.ts`
