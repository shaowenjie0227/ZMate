<h1 align="center">ZMate</h1>

<p align="center">
  <strong>面向 ZCode 的原生桌面管理面板 —— 供应商、中转站集成、MCP、Skills、会话与维护，一站式管理。</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> · 简体中文
</p>

---

## 概述

ZCode 的供应商配置、桌面端设置、MCP、Skills、自定义指令与会话数据分散在 `~/.zcode` 下的多个文件里。接一个中转供应商要手改 `provider_config.json`，清理 Skills 或 `AGENTS.md` 得先找到对应字段——一个手滑就可能弄坏桌面端配置。

ZMate 基于 **Tauri 2 + React + Rust**，把这些高频操作收敛到一个桌面应用里，在本地读写 ZCode 数据，每次改动前自动备份。同时可选接入 **new-api** 协议的中转站，在面板内查看余额、用量与 API 密钥——站点令牌只保存在本机，除与站点通信外不会发往任何地方。

---

## 核心能力

| 模块 | 功能 |
| --- | --- |
| **仪表盘** | 站点余额与今日 / 本周 / 本月用量，ZCode 运行状态与数据健康，会话与 Token 趋势图 |
| **供应商** | 向 `provider_config.json` 注入自定义模型供应商：新增、编辑、启停、删除，支持按模型配置推理档位，改动自动备份 |
| **站点接入向导** | 三种方式接入 new-api 站点：粘贴已有 Key、在站点上创建 Key（可选分组、展示倍率）、手动配置 |
| **流式测速** | 分阶段计时 + SSE 响应流实时展示的连通性测试 |
| **API 密钥** | 站点令牌的查看、创建、启停与删除，一键把密钥导入 ZCode 成为供应商 |
| **使用日志** | 每次请求的输入 / 输出 Token（含缓存命中）、消费金额、首字延迟与总耗时，支持类型 / 时间筛选与分页 |
| **钱包** | 站点余额、累计用量与请求数，兑换码充值 |
| **MCP 管理** | 图形化管理 ZCode CLI 配置中的 MCP 条目，支持备份 |
| **Skills 管理** | 管理 ZCode Skills 生命周期，支持备份 |
| **自定义指令** | 仅管理 `AGENTS.md` 中的 ZMate 受控区块（`ZMATE_*` 标记），支持预览与回滚 |
| **会话** | 只读浏览 ZCode 本地会话：列表、统计，支持完整轨迹 / 按轮次回答两种视图 |
| **维护工具** | ZCode 下载入口、系统诊断、流量代理开关、备份清理、重启 ZCode |
| **系统设置** | 主题、主题色、语言，以及写入前检测 ZCode 是否运行的防冲突保护 |

---

## 数据安全

- 所有配置写入前自动备份，备份统一存放在 `~/.zcode/zmate/`。
- `AGENTS.md` 只修改 `ZMATE_*` 受控区块内的内容，不碰用户自己的内容。
- 会话浏览严格只读。
- 站点访问令牌只保存在本机（`~/.zcode/zmate/settings.json`），且仅发往所连接的站点。

---

## 平台支持

| 平台 | 说明 |
| --- | --- |
| macOS | macOS 12+ |
| Windows | 计划中 |

---

## 技术栈

Tauri 2 · React 18 · TypeScript · Vite · Tailwind CSS · shadcn/ui · Rust

---

## 快速开始

**环境要求：** Node.js · pnpm · Rust · [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)。建议已安装 ZCode 桌面端（大部分功能读取 `~/.zcode` 数据）。

```bash
git clone https://github.com/shaowenjie0227/ZMate.git
cd ZMate
pnpm install
pnpm tauri dev
```

```bash
pnpm build                                        # 前端构建检查
cargo check --manifest-path src-tauri/Cargo.toml  # Rust 检查
pnpm tauri build                                  # 生产构建
```

---

## 项目结构

```text
src/           React 前端
src-tauri/     Tauri 壳与 Rust 后端
src/locales/   国际化（中 / 英）
assets/        文档素材
```

---

## 架构

```text
React UI ── invoke() ──▶ Tauri commands ──▶ core/
                                            ├── ~/.zcode/v2/      (provider_config.json · setting.json)
                                            ├── ~/.zcode/cli/     (config.json — MCP)
                                            ├── ~/.zcode/         (会话 · AGENTS.md · Skills)
                                            ├── ~/.zcode/zmate/   (ZMate 自身数据与备份)
                                            └── new-api 站点       (可选，HTTPS)
                         platform/           macOS 实现（Windows 计划中）
```

---

## 致谢

ZMate 由 [AiMaMi](https://github.com/borawong/AiMaMi)（面向 OpenAI Codex 的桌面伴侣）分叉改造而来，感谢原作者 [@borawong](https://github.com/borawong) 的设计与实现。

---

## 参与贡献

欢迎提交 Issue 与 Pull Request。较大改动建议先开 Issue 讨论方案。

---

## 许可证

[Apache License 2.0](LICENSE)

---

## 免责声明

ZMate 是独立的 ZCode 本地工作流工具，与 Z.ai 无隶属、背书或赞助关系。使用第三方中转站请自行评估风险并遵守相应条款。
