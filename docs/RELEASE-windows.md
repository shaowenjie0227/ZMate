# ZMate Windows 打包发布指南

> macOS 构建沿用原有流程（`pnpm tauri build` 出 `.app`），本文只讲 Windows。
> 本指南对应的适配改动见文末「已做的 Windows 适配清单」。

## 一、环境准备（一次性）

| 工具 | 要求 | 安装 / 检查 |
| --- | --- | --- |
| Node.js | ≥ 20 | `node -v`（本机 20.19） |
| pnpm | ≥ 10 | `npm i -g pnpm`，`pnpm -v` |
| Rust | stable-msvc | 装完勾选默认 `x86_64-pc-windows-msvc`，`cargo --version` |
| VS Build Tools 2022 | 含「使用 C++ 的桌面开发」工作负载 | 需要其中 MSVC v143 + Windows 11 SDK |
| WebView2 Runtime | Win11 自带，Win10 一般也有 | 缺失时 NSIS 安装包会自动装 |

装 Rust：下载 <https://rustup.rs> 的 rustup-init.exe，一路默认即可（默认就是 msvc 工具链）。

装 Build Tools：若还没装，到 <https://visualstudio.microsoft.com/downloads/> 下 "Build Tools for Visual Studio 2022"，勾选 **使用 C++ 的桌面开发**。

## 二、shell 相关的坑（重点）

**坑 1：在 Git Bash 里直接 `cargo` / `pnpm tauri build` 会失败**，报：

```
error: linking with `link.exe` failed
= note: link: extra operand '...rcgu.o'
        Try 'link --help' for more information.
```

原因：Git Bash 自带的 GNU coreutils `link`（/usr/bin/link）抢在 MSVC `link.exe` 前被找到。

解决（三选一）：

```bash
# 方案 1（推荐）：用仓库自带的包装脚本，任何 shell 都能用
cmd /c "scripts\msvc-run.cmd cargo check --manifest-path src-tauri\Cargo.toml"
cmd /c "scripts\msvc-run.cmd node node_modules\@tauri-apps\cli\tauri.js build"

# 方案 2：用开始菜单的 “x64 Native Tools Command Prompt for VS 2022” 执行命令

# 方案 3：直接用 PowerShell / cmd，不走 Git Bash（rustc 自己能定位 MSVC）
```

**坑 1.5：经 `pnpm`（run / exec）转发的命令会把 MSVC 环境弄丢。**

实测 pnpm 在 Windows 上会重建子进程环境：PATH 顺序被重排（GNU link 又赢了）、
`RUSTC_LINKER` 等批处理里设置的环境变量被丢弃。所以构建一律用上面的
`node node_modules\@tauri-apps\cli\tauri.js build` 直接调 Tauri CLI，
不要写成 `pnpm tauri build`。开发时的 `pnpm tauri dev` 同理换成：

```bash
pnpm dev &   # 或另开终端起 vite
cmd /c "scripts\msvc-run.cmd node node_modules\@tauri-apps\cli\tauri.js dev"
```

**坑 2：Tauri CLI 检查 npm 包与 Rust crate 版本不匹配**，报：

```
Error Found version mismatched Tauri packages.
tauri (v2.10.3) : @tauri-apps/api (v2.11.1)
```

npm 侧（`pnpm install` 总装最新）比 Cargo.lock 锁的版本新导致。**不要**用
`cargo update -p tauri --precise` 把 Rust 侧升上去——实测 tauri 2.11.1 与
cargo 解析到的 tauri-runtime / tauri-runtime-wry 组合编译不过（上游 minor
之间有破坏性 API 变更，锁文件拖不动整组）。正确做法是把 npm 侧**降下来配对**，
本仓库已在 `package.json` 里钉死精确版本：

```json
"@tauri-apps/api": "2.10.1",
"@tauri-apps/plugin-dialog": "2.6.0"
```

以后升级 Tauri 时，npm 包与 Cargo.lock 里的同名 crate 必须一起升、同 minor 对齐。

**坑 3：360 安全卫士会静默删除 / 锁定新编译和刚解压的可执行文件**，症状：

- `cargo build` 报 `could not execute process ... build-script-build (never executed) / 拒绝访问 (os error 5)`（文件过几秒就被删）
- tauri 打包阶段 `extracting NSIS / WIX` 时 `Failed to open file: 拒绝访问` 后 panic

360 按文件哈希拦，重编译哈希不变就一直被拦。解决（360 UI 里操作）：

1. 360安全卫士 → 防护中心 → 信任与限制 → **信任区**，添加：
   - `C:\Users\shaowenjie\Desktop\ZMate\src-tauri\target`
   - `C:\Users\<用户>\AppData\Local\tauri`（NSIS / WiX 工具链缓存）
2. 或构建期间临时退出 360。

万一不想动 360，也可以手动把工具链铺到位（bundler 校验通过就不再下载解压）：

- NSIS：`%LOCALAPPDATA%\tauri\NSIS\`（来自 [nsis-3.11.zip](https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip)，SHA1 `EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D`），另需
  [nsis_tauri_utils.dll](https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll)（SHA1 `75197FEE3C6A814FE035788D1C34EAD39349B860`）放到 `NSIS\Plugins\x86-unicode\additional\`
- WiX：`%LOCALAPPDATA%\tauri\WixTools314\`（[wix314-binaries.zip](https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip)，SHA256 `6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31`，平铺解压）

本机已按此铺好，NSIS + MSI 双包已实测产出。

## 三、日常开发

```bash
pnpm install        # 首次
pnpm tauri dev      # 起开发窗口：前端热更新，Rust 改动自动重编
```

前端类型/构建检查：`pnpm build`
Rust 检查：`cmd /c "scripts\msvc-run.cmd cargo check --manifest-path src-tauri\Cargo.toml"`

## 四、打包

```bash
cmd /c "scripts\msvc-run.cmd node node_modules\@tauri-apps\cli\tauri.js build"
```

一条命令产出三样东西（首次会自动下载 NSIS / WiX 工具链到 `%LOCALAPPDATA%\tauri`，需要联网）：

| 产物 | 路径 | 用途 |
| --- | --- | --- |
| 裸 exe | `src-tauri\target\release\ZMate.exe` | 绿色版，可直接双击运行 |
| **NSIS 安装包** | `src-tauri\target\release\bundle\nsis\ZMate_1.0.0_x64-setup.exe` | **日常发布用这个**（本机已实测产出，5.0 MB） |
| MSI 安装包 | `src-tauri\target\release\bundle\msi\ZMate_1.0.0_x64_en-US.msi` 等 | 企业 / 组策略部署（按语言各出一份，本机已实测产出） |

说明：

- Windows 上 `tauri build` 会自动合并 `src-tauri/tauri.windows.conf.json`（打包目标 `nsis` + `msi`），macOS 的 `app` 目标配置不受影响。
- 只想出 NSIS：`... tauri.js build --bundles nsis`，速度快很多（跳过 WiX）。
- NSIS 默认按用户安装（不弹 UAC），想强制装 Program Files：`tauri.windows.conf.json` 里加 `"bundle": { "windows": { "nsis": { "installMode": "perMachine" } } }`。

**发版前统一改版本号**（三处）：

1. `src-tauri/tauri.conf.json` → `version`（安装包文件名用这个）
2. `src-tauri/Cargo.toml` → `version`（改完 `cargo check` 一下会同步 Cargo.lock）
3. `package.json` → `version`

## 五、发布到 GitHub Releases

```bash
git tag v1.0.0
git push origin v1.0.0

gh release create v1.0.0 \
  "src-tauri/target/release/bundle/nsis/ZMate_1.0.0_x64-setup.exe" \
  "src-tauri/target/release/bundle/msi/ZMate_1.0.0_x64_zh-CN.msi" \
  --title "ZMate v1.0.0" \
  --notes "首个 Windows 版本。"
```

没有 `gh` 就在 GitHub 仓库网页 → Releases → Draft a new release → 选 tag → 拖入两个安装包 → Publish。

## 六、代码签名（可选，但强烈建议）

不签名的后果：用户首次运行会碰 SmartScreen「Windows 已保护你的电脑」，需要点「更多信息 → 仍要运行」；部分杀软可能误报。

- **OV 证书**（个人/公司都能买，几百到一千多/年）+ `signtool`：

  ```
  signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a ZMate_1.0.0_x64-setup.exe
  ```

- **EV 证书**（更贵）：SmartScreen 立即建立信誉，不用等下载量积累。
- 不想花钱：先不签，在 README 里提示用户点「仍要运行」即可，功能无任何影响。

## 七、应用内自动更新（当前未启用）

前端已接 `@tauri-apps/plugin-updater`，但 Rust 端 `tauri-plugin-updater` 尚未注册、也没有更新服务器，所以设置页的「检查更新」目前会报错——这是**三端一致**的已知状态，不影响其他功能。当前用户的更新方式 = 重新下载安装包覆盖安装（NSIS 覆盖安装会保留原安装目录，代码里的 `/D=` 逻辑已处理）。

以后要启用的大致步骤：Cargo.toml 加 `tauri-plugin-updater = "2"` 并在 `lib.rs` 注册 → `tauri signer generate` 生成 minisign 密钥 → `tauri.conf.json` 配 `plugins.updater.endpoints` 指向你服务器上的 `latest.json` → 每次发版上传安装包 + 签名后的 `latest.json`。

## 八、已做的 Windows 适配清单

| 模块 | 改动 |
| --- | --- |
| `platform/process.rs` | Windows 上 ZCode 的检测/退出/启动从「暂不支持」补成完整实现：ToolHelp 快照检测（不弹控制台黑框）、`taskkill` 优雅退出 + 强杀兜底、按 `%ProgramFiles%\ZCode` → `%LOCALAPPDATA%\Programs\ZCode` → 注册表 App Paths 顺序定位 ZCode.exe |
| `platform/windows.rs` | 新增 `process_exists`（ToolHelp）与 `registry_default_string`（注册表默认值读取） |
| 托盘图标 | Windows 用白色 glyph（`assets/tray-icon-white.png`）；黑色 template 图标是 macOS 专属机制，直接用在 Windows 深色任务栏上会不可见，且 `icon_as_template` 改为仅 macOS 生效 |
| `tauri.windows.conf.json` | 新增，Windows 打包目标 `nsis` + `msi`（原配置只有 macOS 的 `app`，在 Windows 上会构建失败） |
| `pnpm-workspace.yaml` | 修复未填完的占位符，改为 `onlyBuiltDependencies: [esbuild]`，否则依赖脚本被 pnpm 10 拦截 |
| `package.json` | 钉死 `@tauri-apps/api 2.10.1`、`@tauri-apps/plugin-dialog 2.6.0`，与 Cargo.lock 的 tauri 2.10.3 / tauri-plugin-dialog 2.6.0 同 minor 对齐，绕开 Tauri CLI 的版本检查（见坑 2） |
| `scripts/msvc-run.cmd` | 新增：自动定位 VS 安装并套上 vcvars64 环境执行命令，同时把 rustc 链接器钉到 MSVC `link.exe`（`RUSTC_LINKER`），绕开 Git Bash 的 `link.exe` 冲突与 pnpm 环境重建问题 |

原有代码里已就位的 Windows 支持（无需改动）：单实例互斥锁 + 激活通知、`~/.zcode` 数据目录（Windows 上同为 `C:\Users\<用户>\.zcode`，已实测结构一致）、`explorer` 打开路径、注册表读系统版本号、关闭窗口最小化到托盘。

## 九、实测记录（2026-09，本机）

- Windows 11（26200）x64 · Node 20.19 · pnpm 10.34 · Rust 1.98.1（stable-msvc）· VS Build Tools 2022（MSVC 14.44 + SDK 10.0.26100）
- ZCode 桌面端安装于 `C:\Program Files\ZCode\ZCode.exe`（机器级安装，启动逻辑已覆盖此路径）
- `cargo check` 零错误零警告；NSIS + 双语 MSI 安装包实测产出；`ZMate.exe` 启动冒烟测试通过（窗口 / 托盘正常，进程稳定，干净退出）
- 注意：本机的 VS Build Tools 未注册 vswhere 实例（`vswhere -all` 返回空），所以 PowerShell/cmd 里 rustc 也可能定位不到 MSVC——**统一走 `scripts\msvc-run.cmd` 最稳**

