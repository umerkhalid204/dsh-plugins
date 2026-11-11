# DSH Plugins

Everything published for my **DeepSeek Harness** profile, in one repo: [LM Studio Bionic](https://lmstudio.ai) feature-parity plugins plus my workflow plugins. Install everything with one pasted message on any computer — see [INSTALL.md](INSTALL.md).

## What's inside

| Path | Bundle (package name) | What it does |
|---|---|---|
| `plugins/parity-all/` | `dsh-bionic-parity-all` | **The one-bundle installer**: voice input (local SenseVoice ONNX), the OpenRouter cloud bridge (`openrouter_bridge_status`) (with `bionic_bridge_status` / `ollama_bridge_status` / `openrouter_bridge_status` diagnostics), macOS Computer Use (global), per-session Chromium via Playwright MCP, `install_skill`/`remove_skill` + Bionic/Codex/Claude skill roots, the `document` agent preset, and a Documents hub page. Its npm deps are registry-only; my own code ships vendored under `packages/`. |
| `plugins/local-llm/` | `dsh-plugin-local-llm` | **Local engine layer** (merged from the standalone repo; all 32 offline checks pass on the merged copy): LM Studio / Ollama / Lemonade / Strata / generic llama.cpp-vLLM-LocalAI routes with Settings endpoint editing, model discovery, per-vendor catalog enrichment, declared fallbacks, and the `local_models` tool. Install alongside parity-all; it supersedes parity-all's old local bridge rows. |
| `plugins/career-ops/` | `dsh-career-ops` | Job-search pipeline: ATS scanning, A–H evaluation reports, CV tailoring, outreach, tracker. |
| `plugins/session-delete/` | `dsh-plugin-session-delete` | Hard session deletion (button + `session_delete` tool). |
| `plugins/fleet/` | `dsh-plugin-fleet` | **Profile switcher + fleet orchestration** (v0.1.16): provision/start/stop several detached DSH hosts, each with its own `DSH_HOME`, port and default provider, from one page; plus `engines`/`bench`/`plan`/`balance`/`run` to fan one task out across every LLM engine on the LAN (boxes without DSH included), gated by a Host-verified `@fleet` / `/fleet` keyword and a measured solo-vs-fleet estimate. |
| `plugins/parity-bundles/` | — (dev sources) | The individual bundles the umbrella is assembled from, kept for transparency and per-bundle installs: `dsh-bionic-voice-on`, `dsh-bionic-bridge`, `dsh-computer-use-global`, `dsh-browser-on` (vendored deps), `dsh-skill-install`, `dsh-doc-project-preset`, `dsh-doc-project-ui`. |
| `docs/` | — | `bionic-vs-dsh-gap-analysis.md` (the comparison that drove all of this), `BUILDLOG.md` (build-by-build verification evidence + hard-won Harness plugin lessons), `FLEET-PLAN.md` and `FLEET-ORCH-PLAN.md` (the design and the measured bench data behind the fleet plugin). |

## Install

Paste the block from [INSTALL.md](INSTALL.md) into the target computer's DSH agent chat. One repo, five root-level `github:` path specs — that's a Harness policy requirement (git specs are allowed at the profile root, blocked inside dependency trees), not a preference.

## Provenance

This repo supersedes `dsh-bionic-parity`, `dsh-bionic-parity-all`, `dsh-career-ops`, and `dsh-plugin-session-delete` (archived with their history; new work happens here). Versions: tag `v1.3.0` = fleet 0.1.16 (switcher + orchestration), parity-all 1.0.2 (vendored sub-package manifests committed), local-llm 0.3.0, career-ops 1.0.4, session-delete 1.0.2. Earlier tags: `v1.0.0` consolidation, `v1.1.0`/`v1.1.1` local-llm merge, `v1.2.0` first fleet release.

MIT licensed (vendored third-party packages keep their own licenses).
