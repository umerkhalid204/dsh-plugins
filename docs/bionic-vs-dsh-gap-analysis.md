# LM Studio Bionic vs DeepSeek Harness — Feature Comparison & DSH Plugin Build Plan

*Compiled 2026-11-06. Evidence basis:*
- *Bionic:* official docs ([/docs/bionic](https://lmstudio.ai/docs/bionic) + all section pages), homepage, [LM Link](https://lmstudio.ai/link), [Pricing](https://lmstudio.ai/pricing).
- *DSH:* the live Desktop profile (204 mounted plugin rows via plugin manager), the full Host Service directory (`cordis_inspect`), the shipped plugin package catalog (`packages.md`), and the live `llm-pi-ai` Config JSON Schema.

---

## 1. Positioning in one paragraph

**LM Studio Bionic** is a polished consumer/prosumer agent app: Projects + Sessions, document-first "work projects" in a managed sandbox, coding projects on local folders, Agent-Skills-standard skills, local-first everything (built-in llama.cpp/MLX runtimes, offline voice transcription, model catalog with device-fit + pause/resume downloads), ZDR cloud open models (Kimi K3, GLM 5.3, DeepSeek V4 Flash) on a Free/$20 Bionic+/$100 Pro credit system, and LM Link (Tailscale mesh, preview) to use models on remote devices as if local.

**DeepSeek Harness (DSH)** is a developer-grade agent harness built on the Cordis plugin system: workspaces + event-sourced sessions, subagents/agent-teams/workflows, MCP + LSP, sandboxed shells with permission presets, plans/goals/schedules/webhooks, plugin market + hot reload, agent-preset YAML compositions, and an LLM seam (`llm-pi-ai`) that can address **any** OpenAI-compatible/Anthropic endpoint — but it ships **no model runtime, no model catalog, no managed remote-device link, and several parity features only as unmounted experimental packages**.

---

## 2. Feature-by-feature comparison (Bionic → DSH)

Legend: ✅ equivalent or stronger · 🟡 partial / shipped-but-not-default / config-required · ❌ missing in DSH

| # | Bionic feature | Bionic behavior | DSH status | DSH notes |
|---|---|---|---|---|
| 1 | **Projects** | Group sessions + shared files/context; coding vs document projects | ✅ | Workspaces (`dsh-workspace` + `workspaceRegistry/Controller`): durable registry, pin/archive, per-workspace session tree |
| 2 | **Session tabs & side-by-side split** | Drag session tab to left/right half; compare two live sessions | 🟡 | DSH has one session per view; multiple sessions via sidebar switch; workaround: two browser windows |
| 3 | **Fork a response into a branch beside session** | Fork eligible response → new branched session | 🟡 | DSH supports session fork/resume (log-derived) but no "fork a single response beside me" UI |
| 4 | **Background sessions keep running; done icon** | Tab switch doesn't stop work | ✅ | Sessions run independently; status dots; background jobs panel; goals driver |
| 5 | **Pin / Rename / Archive / Delete sessions** | Session management | ✅ | `workspaceController` remotes: pin/unpin/archive/rename/delete |
| 6 | **Project Files shared across sessions; drag files in** | Managed per-project file set | ✅ | Workspace directory + file upload (`fileUploads`), attachments, `@file` references |
| 7 | **External files stay in place, edited directly** | In-place edits on original paths | ✅ | DSH fs tools edit real paths; sandbox modes fence writes |
| 8 | **Work project = managed sandbox for document iteration** | One-click project type with autosave, live previews | 🟡 | DSH has sandbox modes, Office skills, document previews, per-turn change diffs — but no "document project" wizard, no autosave/live-preview UX, no doc-project preset out of the box |
| 9 | **Generates/revises docx, pptx, xlsx, pdf, md** | Attach → agent authors → review | ✅ | `office`/`office-*` skills, LibreOffice Kit, `office-to-pdf`, bundled Python/pnpm runtimes, `present` deliverables |
| 10 | **Coding project**: index folder, search, edit, Git, shell, change cwd, inline diffs, repo/branch in Files panel | Standard agent coding loop | ✅ | read/edit/glob/grep (ripgrep), `working_directory`, terminals, `workspace-changes` changed-files cards with per-file diff tabs, AGENTS.md instructions |
| 11 | **Sub-sessions for parallel investigation** | Parallel research inside one session | ✅ | Stronger: `subagent`/`subagent_fork`, Agent Teams, `workflow` fan-out scripting |
| 12 | **Skills (Agent Skills standard, agentskills.io)** | Auto-apply + `@` picker; create from finished work; **install from URL**; **import Codex/Claude Code skills** with per-skill toggles in Settings → Skills | 🟡 | DSH skills: SKILL.md-style registry (`skills`, `skill-filesystem`, `tool-skill`), `@` palette, bundles ship skills (career-ops, office). Missing: URL-install flow, other-apps import + management page |
| 13 | **Web search toggle + page extraction** | Settings → General → Web Search | ✅ | `web` seam with DeepSeek/Exa/Perplexity providers + settings page (web_search was failing here only because DEEPSEEK_API_KEY is unset — fix in Models/web-search settings) |
| 14 | **Per-session model picker, Root model default, reasoning level** | Cloud/local/remote in one picker | 🟡 | DSH has per-session model selection + default + reasoning efforts; but picker only shows configured providers (no catalog, no local/remote sources) |
| 15 | **Built-in local model runtimes (llama.cpp + MLX)** | Agent + chat run fully on-device, offline | ❌ | DSH ships no inference runtime at all |
| 16 | **In-app model catalog**: HF search, format/quant variants, device-fit hints, pause/resume/cancel/retry downloads, choose destination device | Settings → Local Models → Explore / Library | ❌ | Nothing equivalent in DSH |
| 17 | **Model load management**: load/unload, idle TTL auto-evict, per-model default load params | Runtime management | ❌ | N/A in DSH (depends on external server) |
| 18 | **LM Studio Secure Cloud**: hosted frontier open models, US-hosted, Zero Data Retention, credits | Kimi K3, GLM 5.3, DeepSeek V4 Flash… | 🟡 | DSH: DeepSeek account + API key providers are first-class; any other open-model cloud (OpenRouter, z.ai, Moonshot…) requires hand-editing `llm-pi-ai` patch config. No curated presets, no ZDR story |
| 19 | **LM Link** (preview): private E2E-encrypted Tailscale mesh; models on remote machines appear as local; download to remote devices; 5 devices free | Device networking + remote inference | ❌ | DSH has SSH remote fs/shell seams and a LAN-reachable Web GUI, but no managed device pairing, tunnel, or remote-model sharing |
| 20 | **Voice input**: realtime multilingual **local** transcription (Voxtral), Settings → Voice, auto-load voice model | Speak to the agent; data never leaves device | 🟡 | DSH **ships** `speechToText` registry + **SenseVoice local ONNX** + client voice-input UI + speech Remote — all as *experimental, not mounted* in this profile. No realtime streaming parity check |
| 21 | **Computer control** (OS-level agent actions) & app automations | Homepage: "automations, and computer control" | 🟡 | DSH ships `computerUse`/`browserUse` seams + providers (cua-driver MCP/native, cua-macos, playwright/chrome-devtools/stagehand) — experimental, unmounted by default |
| 22 | **Automations** (recurring/triggered agent work) | Agent-driven automations | ✅ | Stronger once known: schedules (cron/daily/weekly), GitHub webhooks, ACP server, SDK stdio JSON-RPC, headless one-shot |
| 23 | **Fully offline end state** | Chat + agents + voice + docs offline | ❌ | DSH offline only if an external model server is running; DeepSeek account features need network |
| 24 | **OpenAI-compatible server surface** (LM Studio heritage: `/v1/chat/completions`, embeddings, local server on :1234, headless mode) | Expose models to other apps | ❌ | DSH exposes ACP/SDK/webhooks, not an OpenAI-compatible endpoint |
| 25 | **Plans/credits/org billing, teams** | Free / Bionic+ $20 / Pro $100, organizations, who-pays-for-cloud | N/A | Business service, not a client feature; DSH has DeepSeek account sign-in + balance + Platform billing links |
| 26 | **Localization (14+ languages), themes, shortcuts** | Settings | ✅ | `client-locale` extensible catalog, `ui-theme` light/dark/system, shortcut editor |
| 27 | **Beta channel, changelog, in-app updater** | Release train | 🟡 | DSH has HMR/hot plugin reload; in-app binary updater not verified |

---

## 3. DSH capabilities Bionic does not have (the other half of the difference list)

1. **Full plugin architecture** (Cordis loader patches, hot reload, plugin manager UI, **plugin market/Discover**, dynamic model-authored plugins via `cordis` runner).
2. **Agent presets as YAML compositions** (standard / ptc / minimal / cordis profiles; per-seat preset selection).
3. **Subagents with external engines**: Claude Code Agent SDK, Codex app-server, ACP subprocess, in-process spawn/fork; per-subagent model choice.
4. **Agent Teams**: durable named teammates, peer messaging, shared task DAG with dependencies.
5. **Workflow tool**: JS orchestration fanning out to many subagents with phases/structured results.
6. **MCP client + MCP resources tools**; **LSP seam** (goToDefinition/findReferences/hover) with stdio servers.
7. **OS-level sandbox enforcement** (macOS Seatbelt, bwrap, landlock, Windows ACL) + permission presets (read-only → full-access), approval waterfall, per-tool timeout policy, auto-review LLM authorization.
8. **Schedules/reminders**, **webhooks** (GitHub-signed) that create workspace-backed sessions, **ACP** + **SDK JSON-RPC** + **headless** automation entry points.
9. **Session tooling**: FTS5 session search, session log export, trajectory timing inspector, session inspector, turn-outline/stats projections, session-query model tools.
10. **Context economics**: compaction policy, tool-result pruner, image offload, spill storage with recoverable paths, token meter, checkpoint policy.
11. **Git worktrees** (create + enter), **SSH remote execution seams** (fs/sandbox/subprocess over SSH).
12. **Interactive terminals** in the sidebar + persistent PTY tools; sandboxed **browser tabs** panel in the right sidebar.
13. **Deliverables pipeline**: `present` tool, changed-files cards with comparison tabs, clickable final-response file refs.
14. Claude Code hooks / mods bridge (`dsh-hooks-claude-code`, `dsh-experimental-claude-code-mods`) — run CC hook configs inside DSH.
15. OTel product/session telemetry; message/session feedback; secret masking; CoT translation (experimental).

---

## 4. Missing features in DSH (gap register)

| Gap | What Bionic has that DSH lacks | Severity |
|---|---|---|
| **G1. Local model runtime & model hub** | Built-in llama.cpp/MLX, HF catalog with device-fit, in-app download (pause/resume/retry), load/unload/TTL, fully offline agent | High (Bionic's core identity) |
| **G2. Curated open-model provider presets** | One-click cloud/local/remote open models in the picker instead of hand-edited `llm-pi-ai` YAML | High (cheap to fix) |
| **G3. LM Link equivalent** | Managed device pairing + E2E tunnel so remote machines' models appear local; download to remote devices | Medium |
| **G4. Voice input GA** | Realtime local multilingual transcription on by default, auto-load model, Settings → Voice | High (DSH already ships it, unmounted) |
| **G5. Computer control GA** | OS/browser computer control & app automations on by default | Medium (ships unmounted) |
| **G6. Work-project document UX** | Document-project wizard, project-file drop zone shared across sessions, live auto-refreshing preview, autosave affordance | Medium |
| **G7. Session tabs + side-by-side split** | Two sessions visible in one window | Medium |
| **G8. Skills install/import UX** | Install skill from URL; import Codex/Claude Code skills with a management page | Low–Medium |
| **G9. OpenAI-compatible server output** | LM Studio-style `/v1/chat/completions` server exposing the harness/models to other apps | Low (niche but cheap) |

---

## 5. DSH plugin build plan

All plans follow the harness plugin workflow: author a **bundle in the workspace** (`package.json` + `cordis.patch.yml` + optional Host/Client halves), install via `plugin_manager action: install_bundle` with the absolute directory. Display resources (localized title/description + icon) required per `references/host-plugin.md`. Verify with `cordis_inspect_query` (Service/Config/Slots), not logs. Never hand-edit the profile's `package.json` or `cordis.patch.yml`.

### Phase 0 — enablement bundles (config-only, no new code) — *1 day total*

**P1. `bionic-voice-on`** → closes G4
- Patch inserts: `@deepseek-ai/dsh-experimental-api-speech-to-text` (speechController Remote), `@deepseek-ai/dsh-experimental-speech-to-text` + `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` (local ONNX provider via `speechToText.register`), `@deepseek-ai/dsh-experimental-client-ui-voice-input` (record → editable draft text).
- Config: provider selection + auto-prepare (the seam already has `prepare(id)`; set it so first use doesn't wait, matching Bionic's auto-load).
- Verify: `Config.listConfigs` on mounted rows; `speechController.catalog()` Remote responds; mic button appears in composer.
- Stretch: a small provider plugin registering **Voxtral** via the `speechToText` registry (remote API + credential ref) for realtime streaming parity.

**P2. `bionic-computer-on`** → closes G5
- Patch inserts: `@deepseek-ai/dsh-mcp-client`, `@deepseek-ai/dsh-browser-use` + `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` (or chrome-devtools-mcp), `@deepseek-ai/dsh-computer-use` + `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` + `@deepseek-ai/dsh-experimental-cua-macos`.
- Optional companion: `@deepseek-ai/dsh-experimental-tool-terminal` for scripted app automation.
- Verify: new `browser__*`/`computer__*` tool schemas appear; run one click-and-capture task.

### Phase 1 — configuration presets & skills UX — *2–4 days each*

**P3. `open-model-providers`** → closes G2
- Config-only patch of the existing `include:llm-pi-ai` row: add `providers` entries —
  - `lmstudio-local` → `api: openai-completions`, `baseURL: http://127.0.0.1:1234/v1`, models (GLM 5.2/5.3, Kimi K3, DeepSeek V4 loaded in LM Studio);
  - `ollama` → `http://127.0.0.1:11434/v1`;
  - `openrouter` / `zhipu` / `moonshot` cloud entries with `apiKeyEnv` credential refs (secrets stay in the credentials service, per the MCP-bundle/`!!js` guidance — never inline keys).
- Verify: models appear in the session model picker; a turn completes on a local model with tool calls + reasoning efforts honored.

**P4. `skill-install`** → closes G8
- New small package (Host half only):
  - Tool `install_skill(url)`: fetch via `ctx.web.fetch` → fetch/pin supporting files → validate `SKILL.md` frontmatter → write into a managed skills dir; `skill-filesystem` row config gains that root + roots for `~/.codex/skills`, `~/.claude/skills` (other-apps import parity).
  - Slash command `/skills`: list/enable/disable via `ctx.commands.register` + settings row in the Plugins page (client half optional, weakest mechanism first).
- Verify: install the agentskills.io example; it shows in the session skill catalog and `@` palette.

### Phase 2 — product-experience parity — *1–2 weeks each*

**P5. `doc-work-project`** → closes G6
- (a) **Agent preset** (`dsh-agent-preset` row): "Document Project" composition — doc-work persona system-prompt section, office skills mounted, workspace-write default, present-deliverables emphasized.
- (b) **Client UI plugin**: registers into the right-sidebar tab slots (`Slots.listSubTree` first): a **Project Files** panel — drop zone routed through `fileUploads.uploadStream` into the workspace, list of agent-created files grouped by type, and a **live preview** that subscribes to `workspaceFiles.changes` (already mounted) so documentpreview refreshes the moment the agent edits — Bionic's "every change is automatically saved" feel comes free from DSH's write-through fs; the plugin adds the *visible* autosave/refresh state.
- Verify: create a doc project, ask for a pptx; preview updates mid-turn without reload; dropped PDF lands in Project Files and is `@`-referenceable.

**P6. `session-tabs`** → closes G7
- Investigate `dsh-client-ui-layout` slots; if AppFrame split is host-owned (it is — three-column AppFrame), ship the pragmatic parity first: a **session launcher** that opens a second session in a detached window (DSH web supports multiple windows/peers via `connection`), with pin-to-compare toolbar. True in-app split likely requires upstream host change — flag as such, keep plugin on the seam (`ctx.layout` viewing-state service).
- Verify: two sessions side by side across windows with jump-back links.

### Phase 3 — the model story (Bionic's core) — *2–6 weeks*

**P7. `model-hub`** → closes G1 (realistically: *drive an external runtime* rather than embed one)
- Host package:
  - Providers registered on the `llm` seam via `registerConfigurableProviders` + `registerModelDiscovery(settingsNs, discover)` so **local Ollama/LM-Studio models populate the normal model picker** (this alone makes DSH's picker feel like Bionic's when a runtime is present).
  - Agent tools + CLI-able service: `model_search(query)` (Hugging Face hub API, GGUF/MLX filters), `model_status()`, `pull_model(repo, file)` executed against the **Ollama API (`/api/pull`, streaming progress) or `lms` CLI via `ctx.subprocess`** — pause/resume/cancel map to job registry (`dsh-jobs-local`).
  - Device-fit probe: one-off shell script (RAM/GPU via system_profiler/nvidia-smi) surfaced in UI hints.
  - Runtime launcher: start/stop `ollama serve` / `lms server start` as owned background jobs.
- Client UI: "Local Models" section (Explore | Library | Running) in Settings, registered through the settings slot contract; progress bars from the jobs stream.
- Deliver in slices: **7a** discovery+picker (no UI), **7b** pull tools, **7c** settings page, **7d** launcher + device-fit.
- Verify: with Ollama installed, `qwen3:8b` searchable, pullable with live progress, then selectable in the session model picker and usable with tool calls.

**P8. `openai-compat-server`** → closes G9
- Host package: `webServer.register` routes `/v1/models`, `/v1/chat/completions` (SSE), and a localhost-only bind by default; maps to `ctx.llm.prepareCall/stream` (passthrough) plus an optional **agent mode** that runs the request as a short-lived headless session and streams trajectory events.
- Verify: `curl localhost:PORT/v1/chat/completions` returns a DeepSeek-account completion; OpenAI SDK examples run unmodified.

**P9. `dsh-link`** → closes G3
- Host package: managed tunnel via Tailscale (`tailscale up`, funnel/serve) or cloudflared through `ctx.subprocess` + jobs; a **Link panel** (client UI) showing `connection.authenticatedUrl` QR + device list; per-profile tunnel state in storage domain.
- Pair with P3/P7: remote machines' Ollama/LM-Studio base URLs appear automatically through the same mesh, reproducing "remote models as if local."
- Verify: phone/laptop reaches the home DSH GUI + a remote model shows in the picker over the tunnel only.

---

## 6. Suggested build order (effort vs payoff)

| Order | Bundle | Closes | Effort | Payoff |
|---|---|---|---|---|
| 1 | `bionic-voice-on` (P1) | G4 | S | Instant Bionic signature feature |
| 2 | `open-model-providers` (P3) | G2 | S | Agent runs on local/LM Studio models |
| 3 | `bionic-computer-on` (P2) | G5 | S–M | Computer control parity |
| 4 | `skill-install` (P4) | G8 | M | Skills ecosystem parity |
| 5 | `doc-work-project` (P5) | G6 | M | The document-work headline UX |
| 6 | `model-hub` 7a→7d (P7) | G1 | L | Closes the biggest structural gap |
| 7 | `openai-compat-server` (P8) | G9 | M | Turns DSH into an LM-Studio-style server |
| 8 | `dsh-link` (P9) | G3 | L | LM Link parity |
| 9 | `session-tabs` (P6) | G7 | M–L | UI comfort; may need host seam work |

**Not planned as plugins:** credit/plan/organization billing and the ZDR cloud itself (service/business layer); DSH already has account sign-in, balance, and Platform billing surfaces.

---

### Source links
- Bionic: [Welcome](https://lmstudio.ai/docs/bionic) · [Quick-start](https://lmstudio.ai/docs/bionic/quick-start) · [Projects & Sessions](https://lmstudio.ai/docs/bionic/projects-and-sessions) · [Working with Documents](https://lmstudio.ai/docs/bionic/agent/work-project) · [Coding](https://lmstudio.ai/docs/bionic/agent/code-project) · [Skills](https://lmstudio.ai/docs/bionic/agent/skills) · [Models](https://lmstudio.ai/docs/bionic/models) · [Download Local Models](https://lmstudio.ai/docs/bionic/models/download-local-models) · [Voice Input](https://lmstudio.ai/docs/bionic/voice-input) · [LM Link](https://lmstudio.ai/link) · [Pricing](https://lmstudio.ai/pricing) · [Homepage](https://lmstudio.ai)
