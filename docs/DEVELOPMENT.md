# 账号簿开发与交接

## 在本机开始

主工作目录为 `F:\GPT-Account-Desk`，初始分支为 `main`。项目用 React、TypeScript 和 Vite 构建界面，通过 Tauri 2 调用 Rust 后端。

Windows x64 验证环境为 Node.js 24.20.0、Rust 1.100.0、MinGW-w64 与 Edge WebView2 Runtime。Node 的 `argon2Sync` 用于生成测试库。主工作目录已有独立的 `.toolchain`，同一 Git 仓库的 worktree 会自动找到它。在另一台机器上可安装 Rust、rustfmt、Windows C++ 构建工具和 WebView2 Runtime，或者将 `ACCOUNT_DESK_TOOLCHAIN` 指向已有的便携工具链。这个目录应包含 `cargo\bin`、`rustup`、`mingw64\bin`。Node、Git 和 PowerShell 需可在终端中调用。

```powershell
cd F:\GPT-Account-Desk
./tools/dev.ps1 -Task Setup
./tools/dev.ps1 -Task Dev
```

`Setup` 按锁文件安装 JS 依赖并准备 Rust 依赖。已准备好依赖时可直接运行 `Dev`。重新运行 `Setup` 前先关闭该 worktree 的开发窗口，让 Windows 释放依赖文件。开发模式支持热重载，使用 `.qa\dev-1420` 下独立的账号库和 WebView2 用户目录。开发窗口关闭后，目录仍可供下一次启动复用。

## 并行工作

为不同任务建立独立 worktree，用不同端口启动。示例目录和分支名可按任务修改。

```powershell
git worktree add -b feature/example F:\GPT-Account-Desk-example main
cd F:\GPT-Account-Desk-example
./tools/dev.ps1 -Task Dev -Port 1421
```

每个工作目录各自保存 `node_modules`、构建结果和测试数据。对同一个 worktree 修改代码前，先确认其他 Agent 是否正在使用它。

## 运行验证

```powershell
./tools/dev.ps1 -Task Check
./tools/dev.ps1 -Task Build
./tools/dev.ps1 -Task Smoke
```

- `Check` 构建前端、检查 Rust 格式并运行 Rust 测试。首次原生构建可能需要数分钟。
- `Build` 生成 `src-tauri\target\release\account-desk.exe` 和 `WebView2Loader.dll`。运行时两者放在同一目录。
- `Smoke` 用独立的模拟库启动发布版，覆盖账号详情、改绑标签、重置卡、页面缩放、用量归属、价格区间与库存筛选。截图和测试库位于 `.qa\desktop-*`。并行运行时可用 `-Port 19747` 指定独立端口。

```powershell
./tools/desktop-smoke.ps1 -Scenario DefaultLogs
./tools/desktop-smoke.ps1 -Scenario LivePrice
./tools/codex-login-smoke.ps1 -Executable src-tauri/target/release/account-desk.exe -Output .qa/login
```

`DefaultLogs` 验证从模拟的默认 Codex 目录导入。 `LivePrice` 访问 PriceAI 官方数据源，需要联网。登录取消脚本使用模拟 Codex App Server。旧版升级回归脚本 `windows-smoke.ps1` 和 `quota-smoke.ps1` 需额外提供相应的历史可执行文件。

## 代码入口

| 领域 | 文件 |
| --- | --- |
| 账号台账、导航和设置 | `src/main.tsx`、`src/ui.tsx`、`src/domain.ts` |
| 解锁、账号数据与备份 | `src-tauri/src/main.rs`、`model.rs`、`vault.rs`、`device.rs` |
| Codex 登录、额度与重置卡 | `src-tauri/src/codex.rs`、`login.rs`、`quota.rs`、`src/quota-ui.tsx` |
| 会话用量与目录归属 | `src/usage-view.tsx`、`src-tauri/src/usage.rs`、`usage_commands.rs` |
| PriceAI 快照与图表 | `src/price-view.tsx`、`src/usage-charts.tsx`、`src-tauri/src/prices.rs` |

发布版的默认数据目录是 `%LOCALAPPDATA%\local.accountdesk.vault`。手工测试已构建的程序时可使用 `--data-dir` 加绝对路径。仓库仅保存源码、构建输入、测试脚本和文档。
