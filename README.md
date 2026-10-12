<div align="center">

# 积微 · Jiwei

**积微成著，日进有功**

AI 驱动的学习笔记与个人知识库 — 你记下的每一条笔记，都会成为 AI 回答你时最可靠的信息源。

[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-3d8a74)](LICENSE.md)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-555)

</div>

---

## 下载与安装

安装包在公开的 [积微发布仓库](https://github.com/cl3582175-oss/jiwei-releases/releases)，下载无需登录。代码仓库保持私有。请核对 Release 说明或 `SHA256SUMS.txt` 中的 SHA-256 后再安装。

| 系统 | 安装文件 | 安装方式 |
| --- | --- | --- |
| Apple Silicon Mac（M 系列） | `Jiwei-<版本>-mac-arm64.dmg` | 打开后拖到 Applications |
| Intel Mac | `Jiwei-<版本>-mac-x64.dmg` | 打开后拖到 Applications |
| Windows 64 位 | `Jiwei-<版本>-win-x64.exe` | 运行安装器，可选择目录 |
| Linux | `.AppImage` / `.deb` | AppImage 加执行权限；deb 用系统包管理器安装 |

当前默认使用免费签名方案，尚未购买 Apple Developer ID / Windows 代码签名证书，因此系统可能在首次打开时提示无法验证来源。macOS 若提示 **Apple 无法验证 / 无法验证开发者**，先尝试打开，再进入 **系统设置 → 隐私与安全性 → 安全性 → 仍要打开**。Windows 若提示 **Windows 已保护你的电脑**，选择 **更多信息 → 仍要运行**。只对来自官方发布仓库、SHA-256 一致的安装包放行；签名提示与哈希不能替代来源审查。macOS 替换新版本后可能需要再次放行。

> 真实系统截图待 Claude 发布审查补入：macOS 隐私与安全性“仍要打开”；Windows SmartScreen“更多信息”。本地 P0/P1 技术截图保存在实施审查证据目录。

**English:** Download from [official releases](https://github.com/cl3582175-oss/jiwei-releases/releases) and verify SHA-256. Choose `mac-arm64.dmg` for Apple Silicon, `mac-x64.dmg` for Intel, `win-x64.exe` for Windows, or AppImage/deb for Linux. With the free signing mode, macOS may require **System Settings → Privacy & Security → Open Anyway** after the first open attempt; Windows SmartScreen may require **More info → Run anyway**. Allow only verified official downloads. See [release instructions](docs/release.md) for signing and update details.

## 简介

积微是一款本地优先的桌面学习软件。它把**康奈尔笔记法**、**原始资料管理**和**大模型能力**结合在一起：

- 📝 **康奈尔笔记**：线索栏、笔记栏、总结栏，按黄金比例（0.382 / 0.618）排版
- 📚 **资料库**：书籍、PDF、视频、音频、图片、网页链接统一管理，支持拖拽导入
- 🔎 **全文检索**：SQLite FTS5 trigram 索引，中文检索友好
- 🔥 **学习热力图**：记录每一天的学习强度与连续学习天数
- 🗑️ **最近删除**：删除内容保留 30 天，可随时还原
- 🌗 **深浅色主题**，五种中国传统色强调色（玉、黛、朱、琥珀、紫藤）
- 🌐 **中文 / English** 界面
- 🔒 **数据全部保存在本机**

AI 能力（知识库问答、编辑区 AI 助手、知识图谱、间隔复习等）正在按 [路线图](docs/ROADMAP.md) 逐步交付。积微支持接入任意大模型服务，默认 DeepSeek。

## 快速开始

需要 Node.js 22 或更高版本。

```bash
git clone https://github.com/cl3582175-oss/jiwei.git
cd jiwei
npm install
npm run dev
```

> 国内网络可以先设置镜像以加速依赖与 Electron 下载：
> `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 并使用 `npm install --registry=https://registry.npmmirror.com`

### 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发模式（热更新） |
| `npm run typecheck` | 类型检查 |
| `npm run test:e2e` | 端到端测试（Playwright 驱动真实应用） |
| `npm run dist:mac` / `dist:win` / `dist:linux` | 打包安装程序到 `release/` |
| `npm run db:generate` | 修改数据库结构后生成迁移 |

### 快捷键

| 快捷键 | 功能 |
|---|---|
| `⌘/Ctrl + K` | 命令面板（搜索笔记、跳转） |
| `⌘/Ctrl + N` | 新建笔记 |
| `⌘/Ctrl + 1` / `2` | 笔记 / 资料库 |
| `⌘/Ctrl + ,` | 设置 |

## 技术架构

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron + electron-vite |
| 界面 | React 19 · TypeScript · Tailwind CSS 4 · Radix UI · lucide 图标 |
| 编辑器 | Tiptap 3（ProseMirror） |
| 数据 | SQLite（better-sqlite3）· Drizzle ORM（自动迁移）· FTS5 全文检索 |
| 状态 | TanStack Query · Zustand |
| 国际化 | i18next |
| 测试 | Playwright（Electron E2E） |
| 发布 | electron-builder · GitHub Actions |

```
src/
├── main/            # 主进程：窗口、数据库、业务服务、IPC
│   ├── db/          # 数据表结构与连接
│   └── services/    # notes / sources / trash / categories / settings / stats
├── preload/         # 安全桥接（contextIsolation），根据 API 契约自动生成
├── shared/          # 主进程与界面共享的类型和 API 契约
└── renderer/        # 界面（React）
    └── src/features # notes / library / trash / settings / home / palette
resources/migrations # 数据库迁移（升级时自动执行）
e2e/                 # 端到端测试
```

**扩展一个新能力**：在 `src/shared/types.ts` 的 `JiweiAPI` 中声明方法 → 在 `src/main/ipc.ts` 中实现 → 界面里直接调用 `window.jiwei.xxx`。

## 数据存储

所有数据保存在本机的应用数据目录中（设置 → 数据 可以查看并打开）：

- `jiwei.db`：笔记、分类、资料索引、学习记录
- `library/`：导入的原始资料文件

## 许可证

[PolyForm Noncommercial 1.0.0](LICENSE.md)。

- ✅ 个人学习、研究、非营利组织使用：**免费**
- ❌ **任何商业用途均不允许**，包括销售、商业服务、在营利性产品中使用

如需商业授权，请联系作者。

Required Notice: Copyright (c) 2026 cl3582175-oss (https://github.com/cl3582175-oss/jiwei)
