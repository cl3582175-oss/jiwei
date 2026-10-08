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
