# 积微的打包与发布

代码仓库 `cl3582175-oss/jiwei` 保持私有，安装包与更新 metadata 放在用户创建的公开仓库 `cl3582175-oss/jiwei-releases`。实施代理不创建仓库、不上传、不发布。请由 Claude 联合审查后处理版本号、CHANGELOG、标签与发版。

## 签名模式

默认免费模式：macOS 整个应用使用完整 ad-hoc 签名，不开 hardened runtime，也不公证；打包后必须通过 `codesign --verify --deep --strict`。这能避免资源未封装引起的“已损坏”，仍会被 Apple 提示无法验证。用户拖入应用程序后第一次打开，进入 **系统设置 → 隐私与安全性 → 安全性 → 仍要打开**。更新替换后可能再提示一次。不能把临时签名当作 Apple 已审核或已公证。

Windows 默认未签名：首次通过浏览器下载可能出现 SmartScreen 的“Windows 已保护你的电脑”，选择 **更多信息 → 仍要运行**。仅从官方仓库下载，并核对 SHA-256；部分安全软件仍可能拦截。签名与 SHA-256 不替代来源审查。

以后购买证书，仅设置代码仓库 GitHub Secrets：

| 平台 | Secrets | 效果 |
| --- | --- | --- |
| macOS | `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` | 导入 Developer ID、hardened runtime + Electron JIT entitlements、公证；更新服务检测实际 Developer ID 后全自动 |
| Windows | `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD` | builder 导入代码签名证书；没有时保持未签名 |

macOS 填入 `CSC_LINK` 后必须提供其余完整配置，缺失时打包失败；不静默降级。空证书密码可以为空字符串。不要在终端、日志、review 或聊天中打印证书/令牌/密码。Azure Trusted Signing 可未来通过 builder 的 `win.azureSignOptions` 配置，不与证书模式同时配置。

## 本地检查（不发布）

```sh
npm ci
npm run build
npx electron-builder --mac --dir --publish never
npx electron-builder --mac dmg --arm64 --publish never
codesign --verify --deep --strict -vv release/<version>/mac-arm64/积微.app
spctl --assess --type execute -vv release/<version>/mac-arm64/积微.app
```

免费模式下 `spctl` 拒绝是预期，严格 `codesign` 校验必须成功。测试启动只用临时 `--user-data-dir`。测试 Gatekeeper 时复制安装包/应用给副本加 quarantine；不得改变系统 Gatekeeper 或删除真实用户应用。macOS targets 同时保留 dmg 与 zip，zip 用于未来 Squirrel.Mac 全自动更新和完整 metadata。

## 手动发布步骤

1. 用户创建公开制品仓库 `jiwei-releases`；创建仅有该仓库 Contents 读写的 fine-grained token，设置代码仓库 Secret `RELEASES_TOKEN`。
2. Claude 完成联合审查与真实下载安装/更新验收，按发版约定修改版本号及 CHANGELOG、打标签。
3. 在代码仓库 Actions 的 Release 手动输入标签触发。三平台构建，macOS arm64/x64，产生安装包、`latest*.yml`、blockmap；所有目标发布到公开制品仓库草稿。
4. 检查草稿资产完整、版本一致及 Release 说明里的 SHA-256，复做首次安装与旧版本升级；最后由用户手动发布草稿。更新检查只会发现已发布版本。
5. 自建镜像可在更新页高级设置填写 generic HTTPS 源；自行同步安装包及 metadata，不内置第三方代理。

## 审查仍需实机证据

Safari 真实下载首次打开、x64 macOS、Windows SmartScreen/静默安装/完整更新、Linux AppImage 与 deb 提示路径；Developer ID/Windows 证书模式需真实证书后验收。P0 截图不代替发版安装验收。免费签名限制需在下载页与 DMG 中保持一致。
