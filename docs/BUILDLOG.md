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

## 2026-11-06 (final): monorepo consolidation

All four repos are now this single `dsh-plugins` repo (tag v1.0.0). Canonical install = the three-line block in root INSTALL.md, all `github:umerkhalid204/dsh-plugins#path:plugins/<name>&v1.0.0`. Re-verified live on the desktop profile: three installs applied with zero warnings, profile deps point at dsh-plugins, Documents route serves real data, career-ops skill re-enters the catalog from a path-fragment bundle (git path specs at profile root fully support bundle skills). Old repos (`dsh-bionic-parity`, `dsh-bionic-parity-all`, `dsh-career-ops`, `dsh-plugin-session-delete`) archived with their history; new work lands here.

## 2026-11-06 (merge): dsh-plugin-local-llm -> plugins/local-llm

The October standalone plugin was NOT redundant - it owns seam integration the bridge never did (configurable-provider directory cards with endpoint editing, model discovery, per-vendor catalog enrichment, `local_models scan/use/ping`, offline test suite). It WAS stale: its `strata` route is now owned by the pi-ai adapter on this profile, and it lacked this account's model declarations.
Merge actions: copied into the monorepo; schemastery dep 3.18.5 -> 3.19.0 (host realm); `strata` disabled with a comment; curated MLX model fallbacks added under `lmstudio.models`; parity-all dropped its `bionic-mlx`/`ollama-local` rows (superseded) keeping `openrouter-cloud`. Their offline suite: 32/32 PASS on the merged copy against the fake-engine servers. Old repo deleted after this section is pushed.

## 2026-11-07 (new bundle #11): dsh-plugin-fleet — profile switcher + concurrent hosts

Plan: `FLEET-PLAN.md`. Code: `bundles/dsh-fleet/` (dev) → **live install points at `dsh-plugins/plugins/fleet`** (v0.1.2, `link:`). One Host row (`fleet`: registry, provisioning, process lifecycle, endpoint probe, `/fleet/api/*`, the `fleet` tool) + one Client half (sidebar row + Fleet page). 0 install warnings; row `include:fleet` active; page needs a browser reload.

What it does: 1 Desktop Host (the switcher) + N detached `dsh --profile <id> --patch <generated> --no-open --port <n>` hosts, each with its **own `DSH_HOME`** (`~/.dsh-fleet/<id>`, because `profiles/<name>/lock`, `storages/`, `sessions/` and the projection cache are home-scoped). Every host sees **all** providers; the per-host difference is `agent-default-model`. Provider edits are saved into the plugin's own row via `configEditor` (marked **volatile** → a save updates in place and can never tear down the hosts it manages); the generated provider layer is a separate `--patch` file so re-provisioning never touches an instance's own patch or its saved Settings.

Verified (Harness 0.2.2-rc.1, macOS):
- CLI parity: `@deepseek-ai/dsh@0.2.2-rc.1` exists on npm and ships `dsh-web-frontend/dist` (5.5 MB) → a CLI host serves the real Web UI. Seeded at `~/.dsh/fleet/cli`.
- Provision = `dsh --profile <id> --from-default-profile web --dump-config` (creates the profile), then `--patch <generated> --dump-config` **before any start** — that dump validates `llm-pi-ai`/`agent-default-model` configs, so a refused layer is reported instead of a dead host.
- Start → `dsh web: http://127.0.0.1:<port>/?token=…` captured from the log; token URL → 303 + signed cookie → `/` 200 with `__DSH_BOOT__`; bare `/` and `/api` → 401 without it. pid + status + `urlBase` in state; Stop kills the process group; the host **survived two bundle remove/install cycles and a plugin remount** (detached + pidfile).
- Probe read `/v1/models` live from Strata on `127.0.0.1:47831` (`q2_0`), with Ollama `/api/tags` and LM Studio `/api/v0/models` dialects.
- End-to-end through the **live Desktop Host**: `box-3090` provisioned + started on :3101 (pid 95037) via one same-origin POST; launcher reported `version 0.2.2-rc.1 == wanted 0.2.2-rc.1`.
- Client half: stub-harness 31 asserts 0 failures, 461 click handlers 0 errors, `intervals 15 / cleared 15 / aborts 15` (no leaked timers/fetches).

New harness lessons (add to the list above):
8. **A `link:` bundle outside the profile tree loses the Harness realm.** Node resolves the *realpath*, so bare `@deepseek-ai/*` imports fail → `Config` never projects (`Config.listConfigs` status `absent`) and helper imports return null. The same package installed from **git** sits inside `profiles/desktop/node_modules` and resolves (`status: schema`, per `dsh-plugin-local-llm`). Dev fix: symlink `bundles/node_modules → <a dsh 0.2.2 install>/node_modules`; runtime fix: never *depend* on the realm — this plugin reads the app version from `process.resourcesPath/app.asar/dsh/package.json` as a fallback.
9. **`credentials-local` refuses a credential file readable beyond its owner** (mode 644 → the required `credentials` plugin fails → `connection` and nine dependants never start → `StartupError`). Any code that copies `.credentials.yaml` must `chmod 600`.
10. **Plugin `webServer` routes are not behind the launch-token auth** — `/career-ops/api/state`, `/bionic-docs/api/list`, `/local-llm/api/scan` all answered 200 to a bare `curl` on the Desktop port. Anything a plugin route can *do* (spawn processes, rewrite profile patches) needs its own guard. My first guard (`sec-fetch-site: same-origin` OR `origin === getOrigin()`) then **broke the plugin's own page** — a real browser page does not always satisfy either test, and `localhost` vs `127.0.0.1` are different origins to Chromium even for one loopback listener. Final rule: accept `sec-fetch-site: same-origin`, **or** the Host-issued `dsh-auth-…` cookie (`HttpOnly; SameSite=Strict`, name = prefix + sha256 of the authority — a cross-site page can neither read it, send it, nor have script set a `Cookie` header), **or** an `origin`/`referer` whose *authority* matches with loopback aliases equated and ports exact. Refusals now record the headers they saw under `guard.rejections` in the read-only state route, so the next mismatch is readable instead of guessed. Verified matrix: cross-site 403, bare client 403, session cookie 200, localhost alias 200, wrong-port alias 403.
11. **Electron `process.execPath` is not a Node runner** — spawn the launcher as `execPath <bin.js>` with `ELECTRON_RUN_AS_NODE=1`, else run the shebang script through PATH's node. `dsh --profile x --help` cannot be probed with the profile-name form; use `--version`.
12. A launcher version drift is silently dangerous: the Homebrew `dsh` on PATH is 0.1.1-rc.2 (no `--from-default-profile`, wrong plugin versions). Resolve candidates in order (fleet-local first), prefer an exact match against the running version, and offer `npm install --prefix <root>/cli @deepseek-ai/dsh@<version>`.
13. A pi-ai route with no `models` list is refused and takes the whole `llm-pi-ai` row down → an empty provider catalog must be skipped with a warning, not written. Likewise: an instance whose default asks for a reasoning effort the pack never declares fails every turn with `UNSUPPORTED_REASONING_EFFORT`, and a child cannot resolve an `apiKeyEnv` reference that this Host found in its own ambient environment — provisioning must resolve it and seed it into the child's `.env`.

14. **A Host re-announces its launch token on every hot-reload, and a superseded token is refused with `dsh web authentication required; reopen the URL printed by dsh web.`** Members log that line again each time `dsh-hmr` recomposes them (my own re-provisioning triggered it), so a URL captured at start time goes dead while the process keeps running — the Fleet page's Open handed out exactly that stale address. Rules now: always take the **newest** `dsh web:` line from the member's log (state file is only a fallback and is self-healed on read), and note that tokens are **reusable** (a token address answers 303 and mints a per-client `dsh-auth-<authority hash>` cookie; the plain root answers 401 until that cookie exists). Never pre-validate a token by fetching it in a way the user then can't reuse — it is reusable, so a probe is safe, but it is not proof the *browser* holds a session.

15. **The Desktop shell denies `window.open`** (`setWindowOpenHandler(() => ({ action: 'deny' }))`), so a plugin action that "opens" something must launch the window from the Host. `open -na "Google Chrome" --args --app=<url>` does give a chrome-less app window, **but it spawns a second Chrome instance, which brings its own startup window along** — users read that as a stray "console-like" window. Default is now `openMode: tab` → plain `open <url>` into the browser that is already running (one new tab, no second instance); `chrome-app` stays opt-in, and both report failure through a `spawn` error handler instead of silently doing nothing.

Dev-only scratch, safe to delete: `App Dev/.dsh-cli` (0.2.2 CLI, 908 MB), `App Dev/.dsh-src` (asar reader + extracted docs), `App Dev/.spike` (fleet integration harness runs 1–5, test homes). Harness: `.dsh-cli/fleet-harness.mjs` drives the plugin's real HTTP handlers (guard 403 → save → probe → provision → start → open → logs → stop → delete), green as of run 5.
