# shadcn/ui 组件约定

积微在现有 Electron、React、Radix 和 Tailwind CSS 4 上使用 shadcn/ui 源码组件。导航、工作区布局、配色、中文字体和领域控制器继续由原模块负责。

2026-10-24 范围修订：AI 前端、AI Elements 及其 `ui/button`、`primitives`、`switch`、`confirm`、`ExpandableSurface` 入口保持 v0.14.21；普通页面显式导入 `ui/shadcn-*` 适配。下面的迁移约定适用于普通页面，不能据此改写 AI 控件。获准的公共例外为输入框去描边、已验收的侧栏修复，以及“关于我”四项横排。

## 来源与升级

本次适配来源是 shadcn CLI **4.22.1** 的 **@shadcn / Radix Nova**。源码位于 `src/renderer/src/components/ui`，保留 MIT 声明和 `LICENSE.shadcn.txt`。图标复用 Lucide，类合并复用 `lib/utils.ts` 的 `cn()`；没有引入 Base UI、next-themes 或新的图表引擎。`class-variance-authority` 与 `tw-animate-css` 沿用已有接入配置。

`components.json` 与 TypeScript/Vite 的 `@/` 别名保持一致。Electron 项目被 CLI 识别为 `manual` 是预期结果。

升级时先用项目包管理器读取当前上下文和文档，再逐文件比较：

```sh
npx shadcn@latest info --json
npx shadcn@latest docs button dialog
npx shadcn@latest add @shadcn/button --dry-run
npx shadcn@latest add @shadcn/button --diff button.tsx
```

可使用 shadcn/ui MCP 查询 registry 和示例。不要对已有组件执行批量 overwrite，也不要重新应用默认主题；CLI 版本升级应单独审阅。源码组件中的桌面适配需要保留。

## 主题

唯一主题入口是 `styles/globals.css`。现有 `--accent` 是品牌色，`--muted` 是次要文字，旧 utility 的含义保留。shadcn 组件使用 `primary`、`foreground`、`card`、`popover`、`input`、`ring` 等标准语义；菜单与弱背景使用 `ui-accent` / `ui-muted` 及对应 foreground，避免同名冲突。

映射在 `:root`、`[data-theme]`、`[data-palette]` 作用域重新计算，因此局部配色预览与 portal 都取到正确变量。半径和字体尺度不由 registry 覆盖。`lib/theme.ts` 统一解析系统模式，主窗口、快记窗口与 Sonner 使用同一结果。

## 控件与组合

- `Button` 保留默认 `secondary`、默认 `md` 34px、`sm` / `icon-sm` 28px，以及默认 `type="button"`。普通按钮使用轻底色与悬停反馈，取消常驻描边；主操作显式 `primary`，危险操作显式 `danger`，均使用实色。键盘焦点使用独立的细环。`asChild` 保留子元素原生 type。`size="auto"` 用于已有导航、内容行与领域工具栏的尺寸适配，保留其布局，统一焦点、禁用、ref 与原生事件。
- 文本输入使用 `Input` / `Textarea`；带动作的输入用 `InputGroup`。输入框与输入组合在常态、鼠标及键盘聚焦时均无可见边框、outline 或阴影环；保留边框占位宽度、内边距和原布局，错误通过文字及 ARIA 表达。原生选择用 `NativeSelect`，它保持单个 `<select>`、原生数值 `size`、ref、options 和 change 事件。字段组合使用 `Field`、`FieldLabel`、`FieldDescription`、`FieldError`，关联稳定 ID。
- 用户2026-10-24局部修订：档案五个文本域使用`bg-sunken`区分设置面板；费用与权限的“1美元=”汇率组合框保留与左侧币种选择器一致的`h-9/rounded-lg/border-border/bg-surface/px-3`轻框，不使用accent聚焦边界。该组合框不声明`focus-within:border`，是无框规则的明确例外；其他输入和助手布局不受影响，原字段保存及金额逻辑保留。
- 复选框用 `Checkbox`，以 `onCheckedChange` 的 boolean / indeterminate 语义更新真实状态。单选字段用 `RadioGroup`；`RadioGroupItem variant="choice"` 提供整块可见的选项命中区和键盘导航，默认 variant 保留圆点单选。分段选择统一使用 `ui/segmented`，受控值拒绝空值及选项之外的值。色板继续使用原 tint token，并通过同一 RadioGroup 选择。
- `Tabs` 传递真实 orientation；设置主导航采用 vertical/manual，方向键移动焦点，Enter/Space 才切换，并等待保存屏障。收件箱和批注页签使用受控 Tabs。AI 页面保持发布版页签与状态控制器；“关于我”四项保持发布版切换行为，仅设为同一横行，窄窗口可横向滚动。
- 设置导航使用 `TabsTrigger variant="navigation"`：保留原有 32px 行高、局部字号、品牌配色与卡片阴影，键盘焦点用 2px 内侧轮廓；不叠加分段/下划线页签的装饰。默认与 line 外观保持原路径。设置初始焦点在模态挂载效果结束后的微任务中落到当前选中项，仍在首个就绪帧前完成并滚动到可见区域；已关闭、已卸载或被新焦点/模态取代的请求不再抢焦点。
- `Command` 保留 cmdk 的输入与键盘语义。数据库搜索入口继续 `shouldFilter={false}`；多选状态由原调用者负责。`CommandParts` 仅提供迁移期名称兼容。
- 提示、空态、加载和状态分别使用 `Tooltip`、`Empty`、`Skeleton` / `Spinner`、`Alert` / `Badge`。应用仍使用已有 Sonner，不添加第二个通知状态源。

`shadcn-primitives.tsx` 是普通页面迁移兼容层：`Tip` 的延迟/方向、`DialogContent` 的 title/description/hideClose、`MenuItem` 的 danger、子菜单和 Kbd 均组合对应源组件。`primitives.tsx` 保留发布版供 AI 使用。

## 浮层与真实状态

浮层 content 声明 `data-ui-overlay`，常规遮罩/内容使用 40/50 层级；原生网页检测同时支持 `alertdialog`。CSS z-index 无法遮住 Electron `WebContentsView`，必须保留 BrowserPane 的相交检测、主进程冻结/恢复与截图权限。

`DialogParts` / `PopoverParts` 是同一源组件的非自动 Portal 入口，供已有锚点布局使用，避免双重 Portal。新布局优先完整 `DialogContent` 组合。子菜单单独 Portal，按 Radix 可用高度限制并纵向滚动；Escape 只关闭当前子层并恢复其触发器。菜单关闭时立即卸载，保留入场动效；退场层会把快速重开的触发器点击误判成外部点击，升级时须保留快速重开并选择动作的回归。全屏展示保留原来的同一 mount 和 React 子树，不重新创建编辑器、图表或表单；其 70/80 层级与滚动记忆由既有 ExpandableSurface 负责。

`DialogContent` 的 `placement="custom"` 用于已经提供完整布局与动画的设置等界面，避免再叠加通用居中动画。`DialogOverlay` 默认 `motion="enter"`，配合这些关闭时立即卸载的内容；通用居中 `DialogContent` 会显式选择 `motion="both"`，使内容与遮罩同时完成退场。只有明确取消动效时才用 `motion="none"`。关闭后遮罩和滚动锁必须一起释放，不能只检查对话框已消失。

笔记工作区、笔记编辑器/侧栏、导航和命令面板按实际读取字段订阅应用状态，使用既有 Zustand 的浅比较；设置打开/关闭不应使后台工作区因无关字段变化重复渲染。保存、导航、历史和选中项仍由原 store 与领域控制器负责。

普通页面确认沿用 `shadcn-confirm` 的 `confirm()` / `prompt()` Promise API，队列按 FIFO 显示，取消分别返回 false/null。危险调用方用实体 `operationKey`、覆盖实际写入的 `withActionLock` 和 `useConfirmSignal` 约束生命周期。需要文本提交后写入的 prompt 使用 `submit` 回调；失败保留输入并可重试，提交中不能重复或提前释放写入锁。AI 保留发布版 `confirm` 与独立 host；两类调用不重定向。

设置草稿仍归各字段/原 autosave 拥有；设置切组、关闭及导航统一通过可等待的保存屏障。Query 协调已确认值、待写补丁和广播；review/reflection 支持叶子更新，主进程在当前完整组上合并。数组与既有整体替换分组保留原协议，不套用通用 deepMerge。应用退出的全局超时握手不是此屏障的保证范围。

普通页面的完整替换分组需要合成多个草稿时，使用执行时读取 confirmed 值的设置 updater。AI 专用字段保留发布版保存行为。`sidebars` 按页记录合并，每个页记录仍是完整的 width/collapsed，不把某页更新扩成所有页的旧快照。

`PageSidebar` 保留现有宽度、快捷键和窄窗规则。收起栏为 32px，顶部提供 28px 的展开并固定按钮；书脊文字区悬停仍可预览。预览命中面覆盖整栏高度，标题在预览期间使用 `no-drag`。Electron 的原生窗口命中也受视觉浮层后方的拖动区域影响，因此预览打开期间，`data-page-sidebar` 同时暂停后续正文兄弟及其后代的 `.drag` 区域；离开或固定后自动恢复，避免鼠标仍在预览内却收到整页 mouseleave。离开、固定和 Escape 清理延迟计时。

## 保留的领域原生控件

日期、时间、数值、文件与范围控件在需要浏览器原生解析/选择器时保留原生语义。笔记 TitleInput 的自动增高、beforeinput 重放与标题进入正文生命周期保留；Tiptap/Yjs、PDF、媒体、图谱、脑图与生成式 UI 的状态/权限/稳定 ID 继续由原模块拥有。阅读正文的词元按钮保留文本选择命中边界。领域逻辑不能移入通用控件或以静态界面替代。

生成式 UI 的 Basic Tabs 保留 schema 状态、权限和原 roving controller；练习原生单选按 message/uiKey/题号隔离并保留评分锁定。浏览器标签继续由原生页面控制器拥有，关闭按钮保持独立命中区。卡片、颜色样本、批注标记和日历事件的领域边界可以保留。AI 模型/范围选择器、聊天输入工具行、附件与发送布局均以 v0.14.21 为准。

验证使用 `npm run check`、`npm run build` 及受控 Electron E2E；受控套件用 `playwright.controlled.config.ts`，纯组件夹具用独立 browser config。受控测试会注入构建输出，人工启动前必须重新 build。真实模型、收费服务和跨平台人工验收需分别记录。
