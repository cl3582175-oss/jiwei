# AI Elements

积微使用 [shadcn/ui AI Elements](https://ui.shadcn.com/docs/ai-elements) 的源码组件和组合模式，保留 Electron 的现有 AI 服务及本地数据边界。

## 来源与选择

2026-10-23 通过 shadcn/ui MCP 的 search、view、examples 与 add-command 选择 `@shadcn/message`、`@shadcn/bubble`、`@shadcn/marker`、`@shadcn/attachment`，并通过 CLI dry-run 核对文件和依赖。当前旧 AI Elements 文档提示迁移到 shadcn/ui。

源码位于 `src/renderer/src/components/ai-elements`，附 MIT 许可。

- [Message](https://ui.shadcn.com/docs/components/radix/message)：消息排列、正文和操作区。
- [Bubble](https://ui.shadcn.com/docs/components/radix/bubble)：用户消息气泡和 AI ghost 正文容器。
- [Marker](https://ui.shadcn.com/docs/components/radix/marker)：思考、步骤、依据和生成状态。
- [Attachment](https://ui.shadcn.com/docs/components/radix/attachment)：附件图标、标题、状态及独立操作。
- [Reasoning](https://ui.shadcn.com/docs/ai-elements/radix/reasoning)、[Tool](https://ui.shadcn.com/docs/ai-elements/radix/tool)、[Sources](https://ui.shadcn.com/docs/ai-elements/radix/sources)：结合现有 Radix Collapsible 组成 Trace；审批卡片在折叠区外。
- [Prompt Input](https://ui.shadcn.com/docs/ai-elements/radix/prompt-input)：InputGroup 组合，继续使用现有的受控输入和提交路径。
- [Suggestion](https://ui.shadcn.com/docs/ai-elements/radix/suggestion)：使用现有 Button。
- 模型与聊天内思考选择采用 MCP 的 `combobox-popover` / `input-group-dropdown` 组合：模型用 Popover + cmdk，思考用 DropdownMenu 单选项，均收进输入框底栏。

## 项目适配

上游 `cn` 改为现有 `@/lib/utils`；cva 使用本项目已有的 TypeScript 变体映射方式，只保留实际使用的组件 API。零新增运行时依赖。Attachment 的媒体和内容使用 span，以便合法放入原预览按钮，移除按钮保持独立。

组件直接使用积微的 `surface/sunken/fg/muted/accent/danger` 语义 token。上游 `--muted` 是背景色而本项目是文字色，不能用上游默认主题覆盖。颜色适配留在这些源码组件中，不影响其他页面。

保留原 `Streamdown` 及 Mermaid/交互回答插件、引用定位、回复选区、消息用量、附件授权和 IPC。AI Elements 只负责界面组成，不引入演示会话状态、假响应或独立数据副本。

## 更新

先通过 MCP 和 CLI `--dry-run`/`--diff` 获取新源码，逐个审查适配。不能批量覆盖现有 Button、utils 或全局主题。当前 dry-run 会覆盖 Button 并添加 `cn` 包，因此采用审查过的源码适配。

验证使用 `npm run check`、`npm run build`、`npx playwright test --config=playwright.controlled.config.ts e2e/ai-elements.spec.ts`，以及与改动相关的助手、审批、附件、引用、模型上下文、队列、自动任务和交互回答回归。受控配置隔离 appData 和模型缓存；测试结束后重新构建再启动人工检查实例。受控协议测试不代表真实云模型质量或人工验收。

## 完整功能映射

用户指定的21类已逐项对照实际实现：

| AI Elements 类别 | 积微接入 |
| --- | --- |
| 思维链、工具、推理 | MessageItem 的 Trace/TraceLine，保留全部工具及审批状态 |
| 聊天、信息/消息 | 主聊天、侧栏、就地追问的 Message/Bubble/Content/Footer |
| 确认 | 工具审批、生成式写入确认、AI修改提案、插件能力确认的 Confirmation |
| 语境 | AiPanel、ReplyQuote、ScopePicker、ContextChip 和实际 usage 的 Context/Tag/Usage |
| 内联引用、来源 | InlineCitation 悬浮原文、Source 卡和 Trace 依据；沿用原定位和可信度字段 |
| 型号选择器 | 输入框内的 Popover/cmdk ModelSelector，锚定按钮展开，搜索真实配置、按服务商分组、保留模型选择持久化 |
| 计划、任务 | 生成式 steps/schedule/tasks/list，以及真实自动任务配置和运行记录的 Plan/Task |
| 提示输入、建议 | 三个聊天入口与自动任务解析的 InputGroup，既有 Button 组成建议 |
| 队列 | JobsIndicator 的 Queue/List/Item，保留分道调度、进度、等待、取消、重试和立即执行 |
| 检查点 | 现有笔记版本条目使用 Checkpoint；仍是笔记预览与恢复，不表示聊天回退 |
| 文件树、堆栈跟踪、次级代理人、终端、代码测试结果 | 当前不存在对应真实功能契约；不新增演示树、伪调用帧、伪子代理、命令执行器或测试套件 |

学习测验仍保持答题、解析和错题写入的教育语义；内部作业恢复点仍由后台服务控制。

聊天中的思考强度默认只显示当前档位，打开单选菜单后才显示支持的档位。主对话、项目新对话和窄助手的配置工具均位于 InputGroupTools 内，发送/停止独立在右侧；工具区按可用宽度折行。设置页的完整档位配置保留。模型和思考仍由原会话选择、消息持久化和服务商参数映射负责。

消息呈现按官方 [AI Elements Message](https://ui.shadcn.com/docs/ai-elements/radix/message) 的迁移建议组成：用户使用 `align="end"` 和 `variant="muted"`，气泡宽度至多 80%，采用上游圆角与内边距；AI 使用全宽无底色正文，操作用独立 MessageFooter 和带提示的 ghost/icon-sm 按钮。主对话、窄助手和就地回答共享这套组成，复制走原剪贴板路径。保留 Streamdown 和交互 Provider，不裁切 AI 正文以免破坏选区及全屏。没有引入点赞、分支或重新生成等当前未有业务契约的演示操作。
