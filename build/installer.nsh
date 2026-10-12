!include "MUI2.nsh"
!define MUI_WELCOMEPAGE_TITLE "积微 · Jiwei"
!define MUI_WELCOMEPAGE_TEXT "欢迎安装积微（青风铃出品）。$\r$\n$\r$\n如果看到‘Windows 已保护你的电脑’，请在 SmartScreen 中选择‘更多信息 → 仍要运行’。请只安装来自官方发布仓库且 SHA-256 一致的文件。$\r$\n$\r$\nIf Windows SmartScreen blocks the downloaded installer, choose More info → Run anyway. Verify the installer SHA-256 against the official release."
!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend
