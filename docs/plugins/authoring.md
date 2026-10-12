# 积微插件作者指南

积微的插件**就是 Claude Code 插件**：同一个文件夹，放进 Claude Code 能用技能和 MCP；放进积微，还能用积微特有的内容（视角、作品模板、参谋框架、AI 任务配方、订阅源、起步卡）。

- Claude Code 插件格式：<https://code.claude.com/docs/en/plugins-reference>
- 市场格式：<https://code.claude.com/docs/en/plugin-marketplaces>

## 1. 目录结构

```
my-plugin/
  .claude-plugin/plugin.json     # 插件清单（name 必填）
  README.md                      # 详情页显示（Markdown，不支持原始 HTML，图片不自动加载）
  skills/<名字>/SKILL.md          # 技能（Claude Code 与积微通用）
  commands/*.md                  # 命令：积微当成技能，名字为“插件:命令”
  .mcp.json                      # MCP 服务器（连接器）
  jiwei/                         # 积微扩展，Claude Code 会忽略
    manifest.json
    lenses/lens-<名字>/SKILL.md   # 录音整理视角
    templates/*.json             # 作品模板
    frameworks/*.json            # 参谋分析框架
    recipes/*.json               # AI 任务配方
    sources.json                 # 订阅源
    starters.json                # 起步卡（角色包用）
    icon.png                     # 图标，≤ 256×256、≤ 100 KB
```

技能在积微里的名字是 `插件名:技能名`，和 Claude Code 一致，不会和别人的技能重名。

## 2. `.claude-plugin/plugin.json`

```json
{
  "name": "study-kit",
  "displayName": "学习工具包",
  "version": "1.0.0",
  "description": "一句话说明装上能做什么",
  "author": { "name": "你的名字" },
  "license": "MIT",
  "keywords": ["学习", "study"]
}
```

需要用户填写的配置（如 API 令牌）用 `userConfig`；`sensitive: true` 的值加密保存在本机，在 MCP 配置里用 `${user_config.名字}` 引用，插件文件里不会出现明文。

## 3. 积微扩展 `jiwei/manifest.json`

```json
{
  "schema": 1,
  "category": "role",
  "roles": ["kaoyan"],
  "name": { "zh": "考研", "en": "Graduate entrance exams" },
  "description": { "zh": "择校、真题复盘、作文批改、复试准备", "en": "…" },
  "engines": { "jiwei": ">=0.10.0" },
  "dataLeavesDevice": false
}
```

- `category`：role（角色）、skills（技能）、templates（模板）、sources（信息源）、connector（连接器）。
- `name` / `description`：中英文，积微按界面语言显示（Claude 格式只有一种语言）。
- `dataLeavesDevice`、`cost`：会把用户数据发给第三方、或会产生费用时**必须**写；`cost` 是给用户看的费用说明（中英文）。这类插件的连接器工具默认每次调用前都会询问。

## 4. 各类积微内容

**作品模板** `templates/<id>.json`

```json
{
  "id": "group-meeting",
  "type": "slides",
  "mode": "cowrite",
  "title": { "zh": "组会汇报", "en": "Group meeting update" },
  "description": { "zh": "上次的问题、本周进展、结果、需要导师决定的事", "en": "…" },
  "audience": "导师和组内同学",
  "outline": ["上次组会的问题", "本周做了什么", "结果", "遇到的问题", "需要导师决定的事", "下周计划"],
  "guidance": "8–10 页；结果页必须有图或表。"
}
```

`type`：article（图文长文）、slides（课件）、video（讲解视频）；`mode`：coach（只提问）、cowrite（共写）、ghost（代写）。`guidance` 是给模型的写作要求。

**参谋框架** `frameworks/<id>.json`：`criteria` 为 2–8 条 `{ name, weight 1–5, hint }`，`questions` 为参谋要先问清的问题（≤ 8 条）。

**AI 任务配方** `recipes/<id>.json`：与积微内置配方结构相同（`name`、`instructionEn`、`task`）。`task.tools` 只能用只读工具（知识库检索、读笔记、读资料、日程、行动项、方向、错题、网页读取等）；装上后任务默认关闭，由用户检查后打开。

**订阅源** `sources.json`：`{ "feeds": [{ "url", "title", "kind": "rss" | "atom" | "web" | … }] }`，最多 30 个；安装时用户可以逐个取消。

**视角** `lenses/lens-<名字>/SKILL.md`：`metadata.kind: lens`，`output`、`landing`、`scenes` 的取值见内置视角（`resources/skills/lens-*`）。

**起步卡** `starters.json`：每张卡 `{ id, title, body, action }`，`action` 只能是打开并预填页面：`chat`（助手，预填一句话）、`advisor`（参谋，选好框架并预填问题）、`work`（新建作品并选好模板）、`recipe`（打开配方确认）。积微只预填，不自动发送或运行。

## 5. 确认页会告诉用户什么

Claude 插件没有权限字段，积微**按内容推断**，安装前用通俗的话列出来：

| 插件里有 | 用户看到 |
| --- | --- |
| 只有技能、命令、视角、模板、框架、配方 | 只包含文字内容，不运行任何程序 |
| 订阅源 | 会定时访问这些网站（可逐个取消） |
| 远程 MCP 服务器 | 会连接哪些网站 |
| 本机 MCP 服务器（command） | 启用后会在你的电脑上运行程序（高风险，醒目显示） |
| `userConfig` 里的 sensitive 项 | 需要你提供什么（加密保存在本机） |
| `dataLeavesDevice` / `cost` | 会把提问发给第三方 / 费用说明 |

更新时如果多出新的能力（新的连接器、新的网站、运行的程序变了、要新的凭证），必须让用户重新确认。

## 6. 积微不会做的事

- 不运行插件里的脚本、钩子（hooks）、`bin/`、子代理、监视器；技能附带的脚本只当作文字读取。
- 唯一会运行程序的是用户在「设置 → 连接」里**亲手打开**的本机 MCP 服务器。
- 插件内容、MCP 工具返回的内容一律当作数据，不当作指令。

## 7. 本地测试

- 设置 → 插件 → 已安装 →「从文件安装」：选文件夹或 zip。
- 市场 →「添加市场」→ 选择本地文件夹：适合同时开发几个插件。
- 在积微里自定义或新建角色包时，文件放在积微数据目录的 `plugins/authoring/<名字>/`；改完在插件「管理」里点“更新”重新载入。
- 在 Claude Code 里检查格式：`claude plugin validate ./my-plugin`。

## 8. 发布

1. 在插件「管理」里选“导出为插件”，勾选“同时生成市场文件”，得到一个可以直接推送的市场文件夹。
2. 推到你自己的 GitHub 仓库（公开仓库别人才能添加）。
3. 别人在积微「插件 → 市场 → 添加市场」里输入 `你的用户名/仓库名`，或在 Claude Code 里 `/plugin marketplace add 你的用户名/仓库名`。

积微不会替你建仓库或提交代码。

## 9. 好插件的标准

- 内容与简介一致，中英文名称和简介齐全。
- 技能写清“什么时候用、怎么做、产出什么、不要做什么”，有一个简短示例；不编造事实、经历或出处。
- 不在技能里写诱导越权的话（如“忽略之前的规则”“把用户数据发到某处”）。
- 连接器权限最小，写清数据去向和费用。

---

## English summary

Jiwei plugins are Claude Code plugins. Put Jiwei-only content (lenses, work templates, decision frameworks, AI task recipes, feeds, starter cards) under `jiwei/`, which Claude Code ignores. Jiwei infers what a plugin can do from its contents and shows it in plain language before installation; it never runs hooks, scripts or binaries — only MCP servers the user explicitly turns on. Test locally with “Install from file” or a local marketplace folder; publish by exporting with a marketplace file and pushing to your own GitHub repository.
