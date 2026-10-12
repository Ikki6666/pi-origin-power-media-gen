# Pi 媒体生成扩展（pi-origin-power-media-gen）

[![npm version](https://img.shields.io/npm/v/pi-origin-power-media-gen.svg)](https://www.npmjs.com/package/pi-origin-power-media-gen)
[![license](https://img.shields.io/npm/l/pi-origin-power-media-gen.svg)](./LICENSE)

![preview](https://cdn.jsdelivr.net/gh/Ikki6666/pi-origin-power-media-gen@main/docs/preview.jpg)

通过 Origin Power MaaS 平台给 [Pi](https://github.com/earendil-works/pi) 加多模态生成能力：**文生图、图片编辑、视频生成、音乐生成**。工具名 `maas_*`，目录名即用途：`pi-origin-power-media-gen`。

- npm: https://www.npmjs.com/package/pi-origin-power-media-gen
- GitHub: https://github.com/Ikki6666/pi-origin-power-media-gen

## 安装

```bash
# npm
pi install npm:pi-origin-power-media-gen@1.0.0

# 或从 GitHub（tag 即版本锁定）
pi install git:github.com/Ikki6666/pi-origin-power-media-gen@v1.0.0

# 或从本地路径（开发/试用）
pi install /path/to/pi-origin-power-media-gen
```

## 使用示例

安装后重启 Pi，直接用自然语言说话即可，模型会自动选工具：

```
画一只橘猫在雪地里打滚，水彩风格
把 ~/photo.jpg 的背景换成海边
生成一段 8 秒视频：海边日落，无人机环绕镜头，电影感
给这段歌词谱曲：「[Verse] 雪花轻轻落下...」，风格：流行,女声,钢琴
```

参数直接用自然语言表达（"生成 3 张"、"1024x1536 竖版"、"保存到 ~/Desktop/ai"），或运行 `/origin-power-media-gen` 查看配置与可用模型。

## 工具清单

| 工具 | 说明 | 模型 |
|---|---|---|
| `maas_generate_image` | 文生图（异步任务，自动轮询） | Qwen-Image-2.1-Turbo |
| `maas_edit_image` | 图片编辑（本地文件自动转 Base64） | Qwen-Image-2.1-Turbo |
| `maas_generate_video` | 视频生成（支持首/尾帧参考图） | minimax-h3（最长 15s，768P） |
| `maas_generate_music` | 音乐生成（需提供歌词，模型逐字演唱） | MiniMax-Music3（WAV） |
| `maas_task_status` | 任务状态查询 / 取消（封装 4 条取消路径） | — |

所有生成工具均为异步任务制：插件内部自动轮询（终态即停）→ 产物下载落盘（自动重试 3 次）→ 返回本地路径。图片类工具额外以内嵌图片（ImageContent）返回给模型，可直接基于生成结果继续迭代。

**耗时预期**：图片 10–60s，音乐 20–60s，视频 1–5 分钟。**失败任务不计费**，平台自动退费。

## 模型白名单

内置默认接受 3 个多模态模型（`Qwen-Image-2.1-Turbo`（图片生成+编辑）、`minimax-h3`、`MiniMax-Music3`）；`/origin-power-media-gen` 命令仅显示这些模型，传入白名单外的模型直接拒绝。

更换模型的三种方式：

1. **对话中指定**（需在白名单内）：「用 qwen-image-2512 画一张…」
2. **环境变量覆盖白名单**（无需改代码）：`MEDIA_GEN_MODELS=Qwen-Image-2.1-Turbo,Qwen-Image-2.1,minimax-h3,MiniMax-Music3,qwen-image-2512`，重启 Pi 生效
3. **修改代码默认值**：`extensions/config.ts` 中的 `DEFAULT_SUPPORTED_MODELS`

不管哪种方式，模型最终都会对照网关 `/v1/models` 实时列表校验（缓存 5 分钟），平台下线某模型时会直接报错，不会白跑任务。

## 配置（环境变量）

新名 `MEDIA_GEN_*` 优先，兼容旧名 `YUANLI_*`：

| 变量 | 说明 | 默认 |
|---|---|---|
| `MEDIA_GEN_API_KEY` | 鉴权 Key（回退顺序：`YUANLI_API_KEY` → `AGW_API_KEY`） | — |
| `MEDIA_GEN_BASE_URL` | 网关地址 | `http://api.dev.origin-power.com` |
| `MEDIA_GEN_MEDIA_DIR` | 产物根目录 | `~/.pi/media` |
| `MEDIA_GEN_MODELS` | 模型白名单覆盖（逗号分隔，如 `Qwen-Image-2.1-Turbo,minimax-h3,MiniMax-Music3,qwen-image-2512`）；未设置时用内置默认 | 内置默认 |

产物目录优先级：**工具参数 `output_dir` > `MEDIA_GEN_MEDIA_DIR` > 默认**。产物按类型存放于 `images/`、`videos/`、`musics/` 子目录。

运行 `/origin-power-media-gen` 命令可查看当前配置、白名单来源与可用模型列表。

## 实测约定（与平台接口文档的差异，以实测为准）

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

## 开发与发布

目录结构：`extensions/`（`index.ts` 入口 / `config.ts` / `api.ts`（HTTP 客户端）/ `tasks.ts`（任务引擎）/ `tools/*.ts`）。

```bash
# 类型检查（需 node_modules 软链指向 pi-coding-agent 的依赖 + 本地 tsconfig）
tsc -p tsconfig.json

# 热加载测试
pi --extension ./extensions/index.ts

# 发布新版本：改 package.json version 后
npm publish --access public
```

## License

MIT
