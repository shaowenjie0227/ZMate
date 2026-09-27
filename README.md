<p align="center">
  <img src="assets/app-icon-composed.png" alt="ZMate" width="128" height="128" />
</p>

<h1 align="center">ZMate</h1>

<p align="center">
  <strong>A native desktop management panel for ZCode — providers, relay-site integration, MCP, Skills, sessions, and maintenance in one place.</strong>
</p>

<p align="center">
  English · <a href="./README-cn.md">简体中文</a>
</p>

---

## Overview

ZCode stores provider configuration, desktop settings, MCP entries, Skills, custom instructions, and session data across multiple files under `~/.zcode`. Wiring up a relay provider means hand-editing `provider_config.json`; cleaning up Skills or AGENTS.md means finding the right JSON block first — and one wrong keystroke can break the desktop client.

ZMate is built with **Tauri 2, React, and Rust**. It consolidates these high-frequency workflows into a single desktop app that reads and writes ZCode data locally, with automatic backup before every change. It can also connect to your **new-api**-compatible relay site to surface balance, usage, and API keys — site tokens are stored locally and never leave your machine except to talk to the site itself.

---

## Core Capabilities

| Module | What it does |
| --- | --- |
| **Dashboard** | Balance / today / week / month usage from the connected site, ZCode running status and data health, session & token trends |
| **Providers** | Inject custom model providers into `provider_config.json` — add, edit, enable/disable, delete, with per-model reasoning levels and auto backup |
| **Site import wizard** | Connect a new-api site in three ways: paste an existing key, create a key on the site (group picker with rate multipliers), or manual config |
| **Stream test** | Step-by-step connectivity test with staged timing and a live SSE response stream |
| **API keys** | List, create, enable/disable, and delete site tokens; one-click import a key into ZCode as a provider |
| **Usage logs** | Per-request input/output tokens (with cache hits), cost, first-token latency and total duration; type/time filters and pagination |
| **Wallet** | Site balance, total usage and request count, redemption-code top-up |
| **MCP** | Manage MCP entries in the ZCode CLI config with backup |
| **Skills** | Manage ZCode Skills lifecycle with backup |
| **Custom instructions** | Only the ZMate-managed block in `AGENTS.md` (`ZMATE_*` markers), with preview and rollback |
| **Sessions** | Read-only browsing of local ZCode sessions — list, stats, and a full trajectory / per-turn answer view |
| **Maintenance** | ZCode download portal, system diagnostics, traffic-proxy switch, backup cleanup, restart ZCode |
| **Settings** | Theme, accent color, language, and a write-guard that detects a running ZCode before touching its config |

---

## Data Safety

- Every config write is backed up first; ZMate keeps its own backups under `~/.zcode/zmate/`.
- `AGENTS.md` is only modified inside the `ZMATE_*` managed block — your own content is never touched.
- Session browsing is strictly read-only.
- Site access tokens are stored locally (`~/.zcode/zmate/settings.json`) and only ever sent to the site you connected.

---

## Platform Support

| Platform | Notes |
| --- | --- |
| macOS | macOS 12+ |
| Windows | Planned |

---

## Tech Stack

Tauri 2 · React 18 · TypeScript · Vite · Tailwind CSS · shadcn/ui · Rust

---

## Quick Start

**Requirements:** Node.js · pnpm · Rust · [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). A ZCode desktop install is recommended (most features read from `~/.zcode`).

```bash
git clone https://github.com/shaowenjie0227/ZMate.git
cd ZMate
pnpm install
pnpm tauri dev
```

```bash
pnpm build                                        # Frontend build check
cargo check --manifest-path src-tauri/Cargo.toml  # Rust check
pnpm tauri build                                  # Production build
```

> Windows packaging & release guide (Git Bash linker conflict, NSIS/MSI, GitHub Releases): [docs/RELEASE-windows.md](docs/RELEASE-windows.md).

---

## Project Structure

```text
src/           React frontend
src-tauri/     Tauri shell and Rust backend
src/locales/   i18n (en / zh)
assets/        Documentation assets
```

---

## Architecture

```text
React UI ── invoke() ──▶ Tauri commands ──▶ core/
                                            ├── ~/.zcode/v2/      (provider_config.json · setting.json)
                                            ├── ~/.zcode/cli/     (config.json — MCP)
                                            ├── ~/.zcode/         (sessions · AGENTS.md · Skills)
                                            ├── ~/.zcode/zmate/   (ZMate app data & backups)
                                            └── new-api site      (optional, HTTPS)
                         platform/           macOS implementation (Windows planned)
```

---

## Acknowledgments

ZMate started as a fork of [AiMaMi](https://github.com/borawong/AiMaMi) (a desktop companion for OpenAI Codex) and was reworked for ZCode. Thanks to [@borawong](https://github.com/borawong) for the original design and implementation.

---

## Contributing

Issues and pull requests are welcome. For larger changes, open an issue first so the approach can be discussed early.

---

## License

[Apache License 2.0](LICENSE)

---

## Disclaimer

ZMate is an independent tool for local ZCode workflows. It is not affiliated with, endorsed by, or sponsored by Z.ai. Use third-party relay sites at your own risk and comply with their terms of service.
