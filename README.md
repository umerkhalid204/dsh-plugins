# DSH Plugins

Everything published for my **DeepSeek Harness** profile, in one repo: [LM Studio Bionic](https://lmstudio.ai) feature-parity plugins plus my workflow plugins. Install everything with one pasted message on any computer — see [INSTALL.md](INSTALL.md).

## What's inside

| Path | Bundle (package name) | What it does |
|---|---|---|
| `plugins/parity-all/` | `dsh-bionic-parity-all` | **The one-bundle installer**: voice input (local SenseVoice ONNX), open-model bridge for Bionic/LM Studio MLX + Ollama + OpenRouter (with `bionic_bridge_status` / `ollama_bridge_status` / `openrouter_bridge_status` diagnostics), macOS Computer Use (global), per-session Chromium via Playwright MCP, `install_skill`/`remove_skill` + Bionic/Codex/Claude skill roots, the `document` agent preset, and a Documents hub page. Its npm deps are registry-only; my own code ships vendored under `packages/`. |
| `plugins/career-ops/` | `dsh-career-ops` | Job-search pipeline: ATS scanning, A–H evaluation reports, CV tailoring, outreach, tracker. |
| `plugins/session-delete/` | `dsh-plugin-session-delete` | Hard session deletion (button + `session_delete` tool). |
| `plugins/parity-bundles/` | — (dev sources) | The individual bundles the umbrella is assembled from, kept for transparency and per-bundle installs: `dsh-bionic-voice-on`, `dsh-bionic-bridge`, `dsh-computer-use-global`, `dsh-browser-on` (vendored deps), `dsh-skill-install`, `dsh-doc-project-preset`, `dsh-doc-project-ui`. |
| `docs/` | — | `bionic-vs-dsh-gap-analysis.md` (the comparison that drove all of this) and `BUILDLOG.md` (build-by-build verification evidence + hard-won Harness plugin lessons). |

## Install

Paste the block from [INSTALL.md](INSTALL.md) into the target computer's DSH agent chat. One repo, three root-level `github:` path specs — that's a Harness policy requirement (git specs are allowed at the profile root, blocked inside dependency trees), not a preference.

## Provenance

This repo supersedes `dsh-bionic-parity`, `dsh-bionic-parity-all`, `dsh-career-ops`, and `dsh-plugin-session-delete` (archived with their history; new work happens here). Versions: monorepo tag `v1.0.0` maps to parity-all 1.0.1 / career-ops 1.0.4 / session-delete 1.0.2.

MIT licensed (vendored third-party packages keep their own licenses).
