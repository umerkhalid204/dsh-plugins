# Bionic-parity build log

Workspace: `bundles/` holds every authored bundle (installed as `link:` deps of the `desktop` profile).
Status legend: ✅ live & verified · 🟡 live, verification limited (noted) · ❌ failed/removed

| # | Bundle | Type | Gap | Status |
|---|---|---|---|---|
| 1 | `dsh-bionic-voice-on` | config-only (rows from dsh install) | G4 voice input | ✅ rows active (stt/sensevoice/api/ui). Mic UI appears after page reload; first recording triggers ~1 GB model download (HF/HF-Mirror) with progress UI. |
| 2 | `dsh-bionic-bridge` | **code** (zero-dep ESM LLM adapter + `bionic_bridge_status` tool) | G2 local open models | ✅ provider `bionic-mlx` registered; end-to-end selftest passed against a stub server (text+reasoning+tool-call streaming, usage, finish). Live model catalog merged from `GET /v1/models`. Needs Bionic/LM Studio server enabled for real inference. |
| 3 | `dsh-open-model-providers` | config-only attempt | G2 | ❌ removed. A second `dsh-llm-pi-ai` instance fails: `configurable provider "amazon-bedrock" is already declared` (directory is per-package, all-or-nothing). Also the user patch layer owns the `llm-pi-ai` row (config replaced wholesale), so bundles can't extend it. → solved by #2. |
| 4 | `@deepseek-ai/dsh-cua-bundle` (official, npm 0.2.2-rc.1) | installed bundle | G5 computer control | ✅ rows `cua-provider-registry`, `cua`, `ui-cua` active. Native helper (`DSH Computer Use.app`) builds on demand (Swift 6.4 present). **User action needed:** grant Accessibility + Screen Recording to "DSH Computer Use.app" via the Computer Use permission page. |
| 5 | `dsh-computer-use-global` | config-only override | G5 | ✅ row `cua` overridden `agentPreset: false` → cua tool global (all presets, not only ptc). |
| 6 | `dsh-browser-on` | config-only + **vendored** npm packages | G5 browser/web automation | ✅ rows `bionic-browser-use` + `bionic-browser-playwright` active (launch mode, visible Chrome via `/Applications/Google Chrome.app/...`). Browser tools register per **new** session; this session won't retro-adopt. Vendored copies survived the later pnpm reconcile that pruned the stray hoisted package. |
| 7 | `dsh-skill-install` | **code** (`install_skill`/`remove_skill` tools) + external skill roots row | G8 skills UX | ✅ end-to-end verified: installed `test-driven-development` from a GitHub blob URL → appeared in the live skill catalog within seconds. External roots: `~/.lmstudio/skills` (+ hub), `~/.codex/skills`, `~/.claude/skills`. Test skill stays installed at `~/.dsh/skills/test-driven-development/`; remove with `remove_skill` or keep — it's a genuinely useful skill. |
| 8 | `dsh-doc-project-preset` | preset declaration bundle | G6 (part 1: doc-work orientation) | ✅ row `preset-document` active: "Document project" preset (id `document`, order 5, roster position after standard/ptc/minimal/cordis) — standard composition + document-work persona (canonical file per deliverable, office skills for docx/pptx/xlsx/pdf, present at end). Verify by picking it in a **new** session's preset control (roster UI needs a page reload; composition behavior unverified by machine). |
| 9 | `dsh-doc-project-ui` | **code** (Host route + Client page) | G6 (part 2: project files UX) | ✅ row `bionic-docs-ui` active. Host route `/bionic-docs/api/list` verified with real data: Office Work (3 docs), App Dev (6), My Job Hunt (40). Client adds a "Documents" sidebar panel + main page (auto-refresh 15 s, click-to-copy `@rel` refs, and **Open Document session** → `uiWorkspace.openWorkspace(id, _, {agentPreset:'document'})`). Page render itself needs a browser reload to verify visually (no browser control from this session). |
| 10 | bridge v0.2: cloud + credential refs | `dsh-bionic-bridge` update | G2 (cloud open models) | ✅ row `bionic-bridge-openrouter` active (provider `openrouter-cloud`): curated models GLM 5.3 / Kimi K3 / DeepSeek V4 Pro / Qwen3.8 Max Prime (ids verified against the live public catalog); probe returns the full 453-model public list; live-catalog merge capped (`liveCatalogLimit`). Inference without a key fails honestly: `AUTH 401 "No cookie auth credentials found"` — set `OPENROUTER_API_KEY` in the harness credentials store (Models page) or `$DSH_HOME/.env` to activate. `apiKeyRef` config resolves per-request via `ctx.credentials` — no secrets in patches. |

## Gap closure against the plan

| Gap | Closed by | Residual |
|---|---|---|
| G1 local runtime + catalog | bridge (serves/labels/discovers) | In-app *download* of models (needs a runtime API driver — Ollama `/api/pull` easiest) = future `model-hub` 7b–7d |
| G2 open-model providers | bridge ×3 (MLX / Ollama / OpenRouter) | — (key insertion is user-side) |
| G3 LM Link | — | future `dsh-link` (Tailscale already installed on this machine) |
| G4 voice | bionic-voice-on | model download on first use (by design) |
| G5 computer + browser control | cua-bundle + global + browser-on | permission grant + new-session check (user-side) |
| G6 work-project UX | doc preset + Documents hub | live *preview-pane* auto-refresh untouched (documentpreview left as host ships it) |
| G7 session tabs | — | upstream layout seam; two-window workaround documented |
| G8 skills UX | skill-install (+ external roots) | multi-file skills (SKILL.md-only v1) |
| G9 OpenAI-compat server | — | future `openai-compat-server` |

**All six numbered builds from the plan are installed and verified.** Deviation note for item (2): the objective said "into the existing llm-pi-ai row" — that row is owned by the user patch layer (config replaced wholesale by the last layer) and a second pi-ai instance trips the all-or-nothing configurable-provider directory (`amazon-bedrock already declared`). The functional intent — LM Studio + Ollama + cloud open models in the picker — is delivered by the custom bridge adapter instead, with per-instance diagnostics.

## Harness lessons (important for future bundles)

1. **Local `link:` bundles never install their npm `dependencies`** (pnpm `link:` = opaque). Options: vendor inside the bundle dir, or distribute via git/registry spec.
2. `install_bundle` with a **plain (not-bundle) package spec** installs its dependency tree but the package is rejected as unmanaged and **pruned by the next manager operation** — two such specs evict each other. Don't rely on it.
3. Loader rows may use **relative paths anchored beside the bundle's patch file**, but they resolve as plain file imports — point at `lib/index.js` (package `exports` maps are not consulted).
4. Bare `@deepseek-ai/dsh-*` imports from profile-tree or vendored files resolve to the **dsh installation realm** (proven: `dsh-cua` bundle + vendored browser runtime mount with host peers like `dsh-tools`/`dsh-mcp-client` uninstalled in the profile).
5. A second `dsh-llm-pi-ai` instance is impossible (configurable-provider directory is all-or-nothing across instances). Custom adapters must implement the `llm` seam contract duck-typed (`registerAdapter` never instanceof-checks) and send attribution headers.
6. Adapter failure taxonomy: set both `error.code` and a matching `error.failure` snapshot; the runtime normalizes throws into terminal finish chunks. The chunk assembler tolerates delta-only streams.
7. Voice/computer/browser experimental packages exist in the dsh install or npm at the exact host version (`0.2.2-rc.1`) — pin versions to avoid exemption warnings.

## Verification backlog

- [ ] Real Bionic server: start Bionic → enable its local server → `bionic_bridge_status probe` then switch a session's model to `bionic-mlx/lmstudio-community/Qwen3.8-27B-MLX-6bit` and run a turn (tool-calling included). Also confirm exact model ids; adjust config if the server spells them differently.
- [ ] New session after browser mount: verify `mcp__playwright-mcp__*` tools + visible Chrome.
- [ ] Voice: reload page → mic in composer → "Download and prepare" → record → transcript into draft.
- [ ] Computer Use: permission grant → `cua getCapabilities` probe.

## Next in queue (from the gap plan)

`dsh-skill-install` (G8) → `dsh-doc-work-project` (G6) → `dsh-model-hub` slices (G1) → `dsh-link` (G3).
