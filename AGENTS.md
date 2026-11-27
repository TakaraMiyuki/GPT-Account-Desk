# Agent handoff

- 项目是 Windows x64 本地账号管理应用，当前产品版本为 v0.1.7。开发入口和环境要求见 [开发手册](docs/DEVELOPMENT.md)。
- 在本仓库根目录工作。并行任务使用各自的 Git worktree 和 Vite 端口。改动前查看 git status 及最近提交。
- 运行 PowerShell 脚本时使用 npm.cmd。常用命令是 ./tools/dev.ps1 -Task Setup、-Task Check、-Task Dev、-Task Build 和 -Task Smoke。
- 开发和测试使用脚本分配的 .qa 数据目录及模拟账号。用户的账号库、Codex 会话日志、登录缓存、授权信息和本机工具链留在版本库之外。桌面烟雾测试默认使用模拟数据。
- 前端入口为 src/main.tsx，Tauri 命令与启动入口为 src-tauri/src/main.rs。遵循现有 Rust 数据类型和前端域类型。涉及加密库结构时验证旧版本数据的兼容性。
- 变更后按涉及范围验证。改动影响 Windows 桌面交互时，先 Build 再 Smoke。需要实时验证 PriceAI 时使用文档中的 LivePrice 模式。
