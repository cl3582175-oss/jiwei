# `.jiwei` 交换格式 v1（规范）

`.jiwei` 用于分享笔记、导出整个知识库，或迁移到其他软件。它是一个 **zip 文件**，原则如下：

- **无损**：完整保留康奈尔结构、富内容块、时间信息、来源标记、洞见等数据。
- **可读**：同时附带 Markdown 镜像，没有积微也能阅读内容。
- **可校验**：所有文件都在清单中记录 sha256。

> 状态：规范已确定（v0.1.2）。导入导出功能将在 v1.0 实现，届时只增加字段，不修改已有字段的含义。

## 目录结构

```
example.jiwei
├── manifest.json            清单（必需）
├── notes/
│   └── <noteId>/
│       ├── note.json        元信息（标题、类型、学习日期、状态、标签、分类路径……）
│       ├── doc.json         文档 JSON（ProseMirror 格式，含块 ID 与来源属性）
│       ├── embeds.json      富内容块数据 { [blockId]: { kind, data } }
│       ├── blocks.json      段落块及其时间戳 [{ id, kind, section, rowId, origin, createdAt, updatedAt }]
│       ├── revisions/       （可选）历史版本，<createdAt>.json = { title, doc, embeds, reason }
│       └── note.md          Markdown 镜像（只读，导入时忽略）
├── sources/
│   └── <sourceId>/
│       ├── source.json      元信息（标题、类型、作者、发布 / 获取日期、网址、标签）
│       └── segments.json    （可选）分段 [{ id, ordinal, kind, locator, text }]
├── assets/<sha256>.<ext>    素材（笔记图片；资料原文件仅在 includeSourceFiles=true 时包含）
├── learning/                （可选）goals.json、reviews.json、insights.json、actions.json、cards.json
├── links.json               关联（笔记、资料、洞见之间）
└── annotations.json         批注（W3C Web Annotation 选择器）
```

## manifest.json

```json
{
  "format": "jiwei",
  "version": 1,
  "createdAt": 1791000000000,
  "app": { "name": "积微", "version": "0.1.2" },
  "scope": { "type": "notes", "ids": ["…"] },
  "includeSourceFiles": false,
  "files": { "notes/<id>/doc.json": "sha256…" }
}
```

- `scope.type` 的取值：`notes`（选中的笔记）、`category`（一个分类）或 `vault`（整个知识库）。
- `includeSourceFiles` 默认为 `false`：**分享时默认不包含书籍、视频等版权资料的原文件**，只包含元信息和引用。

## 约定

- **ID**：保留原有 UUIDv7。导入时如果与已有数据冲突，会重新映射，并同步更新 `links`、`annotations` 和富内容块锚点中的引用。
- **时间**：一律使用 Unix 毫秒时间戳。
- **来源属性**：`attrs.origin` 是 JSON 字符串，例如 `{ by: 'ai', model, at, sources, reviewed }`；为空表示用户亲手写的。
- **文档格式版本**：`note.json` 中的 `docVersion` 字段，导入时按该版本执行升级。
- **Markdown 镜像**：每个康奈尔行导出为 `> **线索**` 加正文，总结导出为 `## 总结`，思维导图导出为嵌套列表。
