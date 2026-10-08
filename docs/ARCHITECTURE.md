# 积微架构决策记录

本文件记录影响全局、改动代价高的设计决策。新增功能前请先阅读；推翻任何一条决策都需要在这里写明理由。

---

## 1. 笔记文档模型：单文档康奈尔结构 + Yjs

```
doc
├── cornellRow+ (id)        一行 = 一个知识点：左线索 + 右笔记，横向对齐、互相绑定
│   ├── cornellCue → 段落*   线索 = 将来复习卡片的“问题”
│   └── cornellBody → 段落*  笔记 = 卡片的“答案”
└── cornellSummary (id) → 段落*
```

- **一篇笔记 = 一个 Tiptap 文档**：撤销记录统一、可以跨栏选择、AI 可以一次性操作整篇笔记。
- **每个块级节点有永久 ID**（`@tiptap/extension-unique-id`，MIT）。这些 ID 是段落级时间戳、批注锚点、引用溯源、RAG 分片、复习卡片的共同基础。**ID 不得重新生成。**
- **正文以 Yjs CRDT 状态存储**（`note_docs` 存压缩状态，`note_updates` 追加增量）。这样将来接入多设备同步和多人协作，不需要迁移数据。
- 编辑器结构改变时，必须同时更新 `src/main/lib/derive.ts`，并递增 `DOC_VERSION`。

## 2. 派生数据：主进程从 Yjs 状态生成

渲染进程只负责推送 Yjs 增量。主进程在防抖后从 Yjs 状态派生出以下数据（`src/main/services/docs.ts`）：

| 派生数据 | 表 | 用途 |
|---|---|---|
| 段落块（行块 + 段落块） | `blocks` + `blocks_fts` | RAG 分片、段落级时间戳、批注锚点 |
| 纯文本、字数 | `notes` + `notes_fts` | 列表、检索、统计 |
| 素材引用 | `note_assets` | 素材垃圾回收（只增不减，保证历史版本中的图片不丢失） |
| 正文链接 | `links`（origin = doc） | 知识图谱 |

`derive.ts` 是不依赖 Electron 的纯函数，有单元测试覆盖。

## 3. 时间维度（为“知识会迭代”服务）

| 层级 | 实现 |
|---|---|
| 笔记级 | `learned_at`（学习日期，可修改）、`created_at`、`edited_at`（正文修改时间）、`updated_at`（含元数据变化） |
| 段落级 | `blocks.created_at / updated_at / deleted_at`，通过内容哈希比对得出 |
| 版本历史 | `note_revisions`：内容有变化且距离上次超过 10 分钟时自动快照；按时间稀疏化保留；手动版本与“恢复前存档”永久保留 |
| 知识状态 | `notes.status`（有效 / 存疑 / 已过时）与 `superseded_by`（被哪篇笔记取代） |
| 资料 | `published_at`（发布日期）、`accessed_at`（获取日期） |

v0.2 的 RAG 会在检索结果中携带这些字段：按“相关度 × 时间权重”排序，过时知识降权，并提示新旧知识之间的冲突。

## 4. 同步就绪约定

- 主键一律用 **UUIDv7**（时间有序、全局唯一），不用自增 ID。唯一的例外是 `note_updates.seq`，它只在本机使用。
- 可同步的表都带 `created_at / updated_at / deleted_at（墓碑）/ updated_by（设备 ID）`。
- 元数据按“最后写入者优先”合并，正文按 Yjs 合并。
- 删除一律是软删除；永久删除只发生在最近删除区清理时。

## 5. 素材存储：内容寻址

- 文件按 `sha256` 命名，存放在 `assets/ab/cd/<sha256>.<ext>`，相同内容只存一份。
- 通过自定义协议 `jiwei://asset/<sha256>.<ext>` 访问，支持 Range 请求（音视频可拖动进度）。
- 没有任何资料或笔记引用的素材，由 `collectGarbage()` 删除。

## 6. 关联与批注：W3C Web Annotation

- `links`：笔记 ↔ 笔记、资料、网址；`relation` 字段取 reference / related / supersedes。
- `annotations`：使用 W3C 选择器定位：文字用 TextQuote，PDF 用 page，音视频用媒体时间片段，笔记段落用 BlockSelector。

## 7. 数据安全

- 数据目录可以迁移（复制后重启，原目录保留）；位于云同步盘时会给出警告。
- 每天自动备份，保留最近 7 天、4 周、12 个月；数据库迁移前强制备份。
- 退出时有保存握手：主进程通知渲染进程推送剩余编辑 → 完成派生 → 执行 WAL checkpoint → 关闭数据库。

## 8. 安全边界

- 渲染进程：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`，配合严格的 CSP。
- 渲染进程只能通过 `window.jiwei`（由 `API_SHAPE` 生成）调用主进程。
- AI 生成的可执行内容（v0.3）必须放在独立 origin 的沙箱 iframe 中运行，不能接触 `window.jiwei`。
- v0.1.2 将为所有 IPC 入参加上 zod 校验（见第 10 节）。

## 9. 隐私

笔记和资料都有 `ai_excluded` 字段：为 true 时，任何 AI 调用路径都必须排除它们，包括 RAG 检索、上下文拼装和 MCP 导出。

## 10. 待实施的架构决策（v0.1.2）

- **能力注册表**：每个功能只用 zod 声明一次，同时生成 IPC 接口、AI 工具和 MCP 接口。
- **AI 修改提案**：AI 对笔记的修改以差异形式呈现，逐条接受或拒绝，并可撤销。
- **后台任务**：`utilityProcess` 加持久化任务表，负责解析、转写、向量化，支持断点续跑。
- **工作区**：双栏布局（左资料右笔记）、导航历史、深层链接 `jiwei://note/<id>`。

## 11. 向量模型（v0.2）

- **内置模型：EmbeddingGemma 2**（Google DeepMind，2026-10-06 发布，Apache 2.0 许可）。
  - 文本模型使用 `ggml-org/embeddinggemma-2-GGUF` 的 Q8_0 版本（约 310 MB），输出 768 维向量，支持截断到 512 / 256 / 128 维（MRL）。
  - 多模态编码器（`mmproj`，约 555 MB）可选下载，用于图片、音频、视频检索。
  - 运行时使用 llama.cpp 官方预编译的 `llama-server`（b11491 及以上版本才支持该模型），作为附属进程启动，通过 OpenAI 兼容的 `/v1/embeddings` 接口调用。这样本地模型和云端服务走同一套代码。
  - 提示词格式：查询用 `task: search result | query: …`，文档用 `title: … | text: …`。
- **下载镜像**：ModelScope、hf-mirror、Hugging Face 并行测速，选最快的一个；下载过程中如果速度持续过低，会从断点切换到其他镜像续传；下载完成后校验 sha256。
- 每个向量都记录生成它的模型 ID 和维度；切换模型后在后台重建索引。
- 云端向量服务（OpenAI 兼容接口）可以随时切换使用。

---

# 第二轮决策（v0.1.2 起执行）

## 12. 笔记类型

`notes.kind` 的取值为 `cornell`（默认）、`review`（复盘）、`reading`（阅读笔记）、`free`（自由笔记）。每种类型有自己的文档结构和格式版本（`DOC_VERSIONS[kind]`）。派生逻辑按类型分别处理。

## 13. 富内容块框架

思维导图、流程图、图表、时间线、交互组件、闪卡、测验等都属于“富内容块”。

- 文档中只放一个 `embed` 节点，属性包括 `id`、`kind`、`origin`，节点本身不存数据。`embed` 必须在 `ID_TYPES` 中，否则 `id` 属性会被编辑器丢弃。
- 数据存在同一个 Yjs 文档的 `embeds` 映射中，以块 ID 为键，每个节点都可以独立合并，支持协作。
- 每种块都要在注册表中提供四样东西：
  - 初始数据；
  - `toText`：转成文字，供检索、RAG 和字数统计使用，主进程派生时会调用；
  - 静态预览：供导出和历史版本预览使用；
  - 渲染和编辑组件。
- 思维导图使用我们自己定义的树结构（节点 = 文字 + 子节点 + 原文锚点），可以和康奈尔行互相转换。

## 14. 内容来源（谁写的）

带 ID 的节点都有 `origin` 属性：

- 为空表示用户亲手写的；
- 为 `{ by: 'ai', model, at, sources, reviewed }` 表示 AI 生成的。

用户修改过的 AI 内容自动标记为 `reviewed`。派生出的块记录在 `blocks.origin` 字段中，取值为 user / ai / ai_reviewed。

学习统计（热力图字数）只计算用户亲手写的和审阅过的内容。复盘和检索也会区别对待这三种来源。

## 15. AI 修改提案

AI 不直接修改笔记，而是创建提案（`proposals` 表）。提案里是一组以块 ID 定位的操作，包括插入、替换、删除。用户在界面中逐条接受或拒绝；接受后的内容以 AI 来源写入，可以撤销。

## 16. 能力注册表

所有能力都用 zod 声明一次，包括名称、参数、说明、AI 是否可调用、是否有副作用。注册表自动生成以下内容，并在主进程统一校验参数：

- 渲染进程的 `window.jiwei` 接口（含类型）；
- AI 工具列表（v0.2 起使用）；
- MCP 接口（v1.0）。

## 17. 资料分段

`source_segments` 是和笔记的 `blocks` 对称的资料片段表，记录每段的定位（`locator`，使用 W3C 选择器）和文字。批注、引用溯源、导图节点锚点、RAG 都通过它定位到资料内部。

## 18. 后台任务

`jobs` 表负责持久化任务。主进程调度任务（失败重试、退避等待、重启后续跑），通过 `utilityProcess` 在独立进程中执行耗时任务，进度以事件形式推送给界面。

## 19. 工作区

- 双栏布局：资料 | 笔记，比例可以拖动，默认按黄金比例。
- 支持导航历史（⌘[ / ⌘]）。
- 支持深层链接 `jiwei://note/<id>` 和 `jiwei://source/<id>`。
- 工作区上下文（当前笔记、光标所在块、选中文字、当前资料及其位置、资料中的选区）会随每次 AI 请求一起发送。
- AI 输入框位于整个工作区的右下角。

## 20. 知识库与身份

- **一个知识库 = 一个数据目录。** 软件可以创建、打开、切换多个知识库。共享时同步整个目录，所以任何表都不需要“所属空间”字段。
- `users` 记录用户，`devices` 记录设备及其所属用户。`updated_by` 存设备 ID，通过设备表对应到人。
- 共享知识库时，默认不包含版权资料的原始文件。

## 21. 学习闭环数据

`goals`（学习目标）、`reviews`（复盘会话）、`insights` + `insight_versions`（洞见及其演变）、`actions`（行动项）、`cards` + `review_logs`（FSRS 复习）、`learner_memories`（学习者画像）。

关联类型扩展为：reference / related / supersedes / evidence / derived_from / contradicts / applied_in。

复盘节奏的默认值：每天 1 分钟微复盘，每周一次完整复盘（周日晚）。

## 22. 交换格式

`.jiwei` 包，规范见 `docs/FORMAT.md`。

## 23. 编辑器加载期间的输入

标题回车时，如果编辑器还在加载（Yjs 文档读取为异步），随后的按键会按顺序缓冲：文字直接缓冲，功能键（Tab、Enter、退格）作为按键事件缓冲。编辑器就绪后，这些输入通过编辑器自己的按键处理逐一重放，保证一个字都不会丢、也不会落到标题里。

## 24. 设计系统（v0.1.3）

- 设计令牌集中在 `src/renderer/src/styles/globals.css`：配色方案通过 `<html data-palette>` 切换，深色通过 `data-theme` 切换，两者可以组合。
- 自定义设计类（`.panel`、`.paper`、`.glass`、`.tint`、`.stack`）放在 `@layer components` 中，以确保 Tailwind 工具类可以覆盖它们。**新增设计类也必须放在这一层。**
- 粉彩色通过 `data-tint` 加 `.tint` 或 `.tint-ink` 使用；分类颜色存在 `categories.color` 中，未设置时按 ID 稳定分配。
- SVG 的 presentation 属性不能使用 CSS 变量，填充颜色要写在 `style` 中。
- 插画统一使用 `currentColor` 加配色变量，以适配所有配色和深色模式。

## 25. AI 服务与思考强度（v0.2）

- 所有模型调用都在主进程中进行（Vercel AI SDK），使用 Electron `net.fetch` 以继承系统代理。渲染进程永远拿不到 API Key。
- API Key 由 `safeStorage` 加密后存入 `providers.api_key_enc`。换机器或重装系统后需要重新填写。
- 思考强度统一为 `off / low / medium / high / max`。`src/shared/ai.ts` 声明每个服务商支持的档位，`model.ts` 将档位翻译成各家参数（例如 DeepSeek 使用 `thinking` 加 `reasoning_effort`）。新增服务商只需修改这两处。

## 26. 知识库检索

- 笔记段落与资料片段统一切成 `chunks`，其整数 rowid 对应 `vec_chunks`（sqlite-vec，512 维，余弦距离）。
- EmbeddingGemma 原生输出 768 维，按 MRL 截断到 512 维后归一化。更换向量模型会触发重建索引。
- 检索流程：FTS5 与向量检索各取候选，经 RRF 融合，再按时间和知识状态（过时 / 存疑降权）加权。标记为 `aiExcluded` 的内容在检索阶段过滤掉。
- 回答中的 `[n]` 对应系统提示中的编号片段。只有被引用的片段会作为引用保存，编号保持原样，以便和正文对应。

## 27. 真实服务端到端测试

- `e2e/chat-live.spec.ts` 仅在设置 `JIWEI_IMPORT_PROVIDERS_FROM=<用户数据库>` 时运行。它把加密后的服务商配置复制到临时数据目录，测试代码不解密 Key，也不输出 Key。
- Playwright 默认注入 `--use-mock-keychain`，会导致无法解密 Key。开发构建在设置上述变量时会移除这个开关，安装版不受影响。

## 28. 智能体内核（v0.3.0）

- 一个内核服务三个入口（就地卡片、工作区面板、对话页）：`services/ai/chat.ts` 负责组装提示和多步工具循环（AI SDK 的 `stopWhen`），`tools.ts` 定义精选工具，`context.ts` 解析上下文包。
- 工具参数刻意保持简单：内容用 Markdown 或嵌套结构表示，由 `lib/markdown.ts` 和 `fromNested` 转换为合法的文档节点。写入一律调用 `createProposal`。
- 能力注册表中带 `ai` 标记的能力保留给将来的 MCP 导出；对话使用 `tools.ts` 中的精选工具，以减少工具描述占用的 token、降低模型出错率。
- 读取工具会跳过已删除和“不让 AI 读取”的笔记与资料。检索范围为“不使用知识库”时，不提供读取工具。
- 提示结构：系统提示只放规则、技能目录、用户卡片和日期，内容不变时每轮字节相同，可以命中前缀缓存。上下文、检索片段和预加载的技能放在本轮用户消息里。历史消息只带原话。
- 模型或接口不支持工具调用时，自动去掉工具重试一次。

## 29. 技能

- 采用 Agent Skills 开放标准。内置技能位于 `resources/skills/<name>/SKILL.md`，用户技能位于 `<userData>/skills`，同名时用户版本优先。积微扩展字段放在 `metadata` 中：`title`、`min-model`、`surfaces`。
- 渐进加载：系统提示里只有名称和简介；`skills_load` 加载正文，并附带用户对该技能的偏好（记忆中 kind 为 skill 的条目）；快捷操作可以通过 `ChatSend.skill` 预加载，省去一次路由。
- `modelTier()` 根据模型名判断模型能力是 basic 还是 strong。要求 strong 的技能不会出现在弱模型的技能目录中。
- `knowledge-synthesis` 改编自 anthropics/knowledge-work-plugins（Apache-2.0），许可证随技能目录一同分发。

## 30. 记忆

- 记忆存储在个人数据库 `<userData>/profile/memory.db` 中，独立于知识库：切换、迁移或共享知识库都不影响记忆，记忆也不会同步给协作者。迁移由 `user_version` 管理。
- 每条记忆包含：类别、可选的 key（个人档案）或 skill、敏感标记、状态（active / pending / archived）、钉住、来源与证据、生效与失效时间、使用次数。
- 由 AI 写入的敏感记忆先进入 pending 状态，经用户确认后才生效。普通记忆直接生效，界面提示并可以撤销。
- 用户卡片限制在约 600 token 以内，排序固定（钉住 → 使用次数 → 创建时间），便于命中缓存。
- 无痕对话不提供记忆工具，也不携带用户卡片。

