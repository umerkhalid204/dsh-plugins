# Fleet — DSH profile switcher & multi-instance launcher (plan)

Goal: from one DSH, run and switch between 4–5 concurrent DSH hosts, each preconfigured with a
different LLM provider (your 4 LLM boxes), with every provider configurable, save-able and
re-configurable from the UI.

Confirmed choices (2026-11-06):

| Decision | Choice |
|---|---|
| Instance shape | 1 Desktop app (the one you are in) + up to 4 `dsh --profile web` Host processes on their own ports |
| Isolation | Separate `DSH_HOME` per instance (`~/.dsh-fleet/<id>`) — no lock/storage contention |
| Provider scope | Every instance sees **all** providers; each instance opens with a **different default** model |
| Provider config | Fully editable in the Fleet UI (add/edit/delete provider + models, test endpoint, save into each instance profile) |

## 1. Facts established from the installed runtime (0.2.2-rc.1)

These constrain the design; each was read out of the shipped code, not assumed.

1. **Desktop is hard single-instance.** `app.asar/lib/main.js:21404` →
   `claimDesktopSingleInstance(app, …)` → `app.requestSingleInstanceLock()`; a second launch just
   focuses the first window. So extra instances cannot be extra Desktop processes.
2. **Desktop always boots `$DSH_HOME/profiles/desktop`** (`resolveDesktopPaths`, main.js:1784) and
   the webserver port is composed config (`@deepseek-ai/dsh-host-webserver`: `host`, `port`,
   `0` = OS-assigned). This app is on `127.0.0.1:50658`.
3. **A CLI web host is a separate app**: `dsh --profile <name> web|… --no-open --port <n>`;
   flags `--host --port --public-url --trusted-host --tls-cert --tls-key --no-open`
   (`@deepseek-ai/dsh-web-app/lib/startup.js`). Default port 3080. Startup prints a **tokenized URL
   line** (`dsh web:`) that mints a signed cookie; wildcard binds are rejected.
4. **Custom profiles from a template are a first-class CLI feature**:
   `dsh --profile <name> --from-default-profile web` creates/replaces a non-shipped profile
   (`@deepseek-ai/dsh-app-boot` README §Profiles).
5. **Version gate.** Plugins are admitted against `getDshRuntimeVersion()`. The Desktop app is
   `0.2.2-rc.1`; the CLI used to launch instances must be the same version
   (`@deepseek-ai/dsh@0.2.2-rc.1` exists on the public npm registry — verified).
6. **Patch semantics: a row override replaces `config` wholesale.** To add providers we must restate
   the whole `llm-pi-ai` config → the provisioner derives the base from
   `dsh --profile <name> --dump-default-config` instead of hardcoding it.
7. **Home-scoped state**: `profiles/<name>/lock`, `sessions/`, `storages/` (workspace registry,
   projection cache, `schedule.json`), `attachments/`, `.env`, `.credentials.yaml`. Two Hosts sharing
   one home race on those files → per-instance home is the safe design.
8. **Home-level `$DSH_HOME/cordis.patch.yml` outranks the per-profile patch** — never write fleet
   config there.
9. **Own-config persistence is `configEditor`**: `ctx.get('configEditor').edit(ctx.fiber.entry, …)`;
   an ordinary field change **restarts the plugin**, so instance children must be `detached` and
   tracked by pidfile, not by in-process handles.
10. **UI patterns proven in this profile**: Client half registers into `sidebar.panellist` + `main`
    slots (career-ops), Host side uses `webServer.register({kind:'exact', path, handler})` routes
    consumed by `fetch()` from the page, theme via `--dsw-alias-*` tokens. No iframes for plugin UI.
11. **Provider shape already used by this account** (`~/.dsh/profiles/desktop/cordis.patch.yml`):
    `llm-pi-ai.config.providers.<name> = { apiKeyEnv, api, baseURL, displayName, models[…] }`.

## 2. Architecture

```
Desktop DSH (profiles/desktop, ~/.dsh)                    ← the switcher lives here
  └─ dsh-fleet bundle (Host plugin + Client page + `fleet` agent tool)
       registry (fleet row config, written by configEditor)
         providers[]   shared catalog: engine, baseURL, apiKey, models[]
         instances[]   id, label, port, home, default{provider,model}, providers[], bundles[], seedEnv
       │ provision                     │ start / stop / status
       ▼                               ▼
~/.dsh-fleet/gpu-a/            spawn: DSH_HOME=~/.dsh-fleet/gpu-a \
  profiles/gpu-a/                dsh --profile gpu-a --from-default-profile web \
    package.json                   --no-open --port 3101
    cordis.patch.yml  ← generated  (detached; stdout → ~/.dsh-fleet/logs/gpu-a.log)
      webserver{host,port}         prints `dsh web: http://127.0.0.1:3101/#<token>`
      llm-pi-ai{providers: ALL}    → URL captured, shown as “Open” in the panel
      agent-default-model{…}
```

* The **registry is the plugin's own Config** (one YAML document in the profile patch) — so it is
  hand-editable, survives upgrades, and hot-reloads.
* Every instance receives **all providers**, with `agent-default-model` pinned per instance
  (satisfies “all 5 providers, different default”).
* Children are detached: they survive plugin reloads and Desktop restarts; `stop` uses the pidfile /
  process group.
* `seedEnv` copies `.env` + `.credentials.yaml` from the parent home into a new instance home so the
  DeepSeek/OpenRouter credentials work there too (off ⇒ isolated credentials).

## 3. Contracts (so Host and Client are built in parallel)

Host routes, same-origin `fetch`, JSON in/out. One `operations` object serves both routes and the
`fleet` agent tool.

| Route | Body → Result |
|---|---|
| `GET /fleet/api/state` | → `{ok, launcher:{path,version,wanted,ok,reason}, instances:[…], providers:[…]}` where each instance carries `status: running\|down\|provisioned\|missing\|error`, `pid`, `port`, `url`, `default`, `logTail` |
| `POST /fleet/api/action` | `{action:'provision'\|'start'\|'stop'\|'restart'\|'forget'\|'probe-instance', id}` → `{ok, instance, error?}` |
| `POST /fleet/api/save` | `{instances?, providers?}` → validated, `configEditor`-persisted → `{ok, instances, providers, warnings[]}` |
| `POST /fleet/api/delete` | `{kind:'instance'\|'provider', id}` → `{ok}` |
| `POST /fleet/api/probe` | `{baseURL, apiKey?, apiKeyRef?, api?}` → `{ok, models:[{id,name?,contextWindow?}], error?}` (reads `<baseURL>/models`, LM Studio `/api/v0/models`, Ollama `/api/tags`) |
| `GET /fleet/api/logs?id=` | → `{ok, lines:string[]}` |

Agent tool `fleet` — `action` mirrors the routes:
`list`, `add-instance`, `add-provider`, `save`, `provision`, `start`, `stop`, `restart`, `open-url`,
`logs`, `probe`, `remove`.

## 4. Milestones

| # | Deliverable | Verified by |
|---|---|---|
| M0 | This plan + spike: matching CLI runtime installed locally, one provisioned instance booted, URL reachable | `curl` of the instance root, `dsh --dump-config` of the generated profile |
| M1 | Host plugin: registry + configEditor persistence, provisioner (patch generation), spawn/stop/status/logs, provider probe, `fleet` tool | `fleet` tool calls from this session; a real second host answering HTTP |
| M2 | Client page + sidebar panel: instance rows, status dots, Open/Start/Stop/Restart/Logs, launcher health banner | live page in the Desktop UI |
| M3 | Editors: instance CRUD, provider CRUD, endpoint test → model list picker, default-model picker, `save` | create/edit a provider and re-provision from the page |
| M4 | Hardening + docs: autostart, `openMode` (browser tab / Chrome app window), README, INSTALL.md line, BUILDLOG entry | install into the `desktop` profile, restart-safety check |

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| npm CLI ships no built frontend → no Web UI | spike M0 checks `@deepseek-ai/dsh-web-frontend` dist inside the install; if missing, fall back to the Desktop-installed runtime or ship a static dist copy |
| Port collision (3080/50658/…) | fleet assigns 3101+ by default, probe before start, clear error if busy |
| Two Hosts on one home corrupting state | per-instance `DSH_HOME`, never shared |
| Plugin reload killing instances | detached spawn + pidfile tracking |
| `llm-pi-ai` config replaced wholesale, wiping DeepSeek providers | provisioner merges over `--dump-default-config` output, never over the user's own layer; writes go to the *instance* profile only |
| Child instances boot a *stale* profile after provider edits | `restart-required` flag in state; one-click re-provision + restart |
| Version drift after a Desktop auto-update | launcher check compares `dsh --version` with the running host version; UI banner + `install matching runtime` action |

## 6. File layout (workspace, then copied into the monorepo as `plugins/fleet`)

```
bundles/dsh-fleet/
  package.json          # dsh.bundle.patch + dsh.client + exports/locale/icon
  cordis.patch.yml      # - insert: [{id: fleet, name: dsh-plugin-fleet, config: {...}}]
  index.js              # Host half: operations + routes + tool
  client.js             # Client half: sidebar.panellist + main page
  locale/en.json        # meta.title/description + UI strings
  icon.svg
  README.md
```

Out of scope for v1 (recorded, not silently dropped): running DSH *on* the four LLM machines and
linking them (upstream “LM Link” gap), per-machine sandbox/SSH executors, and multi-window tab
support inside the Desktop app (upstream layout seam).

## 7. Delivered (2026-11-07)

Shipped as `dsh-plugin-fleet` v0.1.2 — dev copy `bundles/dsh-fleet/`, canonical copy
`dsh-plugins/plugins/fleet/` (the live profile link points at the canonical one).
Full result log: `BUILDLOG.md` §“new bundle #11”.

| Milestone | State |
|---|---|
| M0 spike (CLI parity, profile creation, token auth, frontend dist) | done — see facts 1–6 above, all re-confirmed |
| M1 Host core + `fleet` tool | done; driven end-to-end through the live Desktop Host (`box-3090` running on :3101) |
| M2 Fleet page + sidebar row | code done, page render needs one browser reload to eyeball |
| M3 instance/provider editors + endpoint test | code done; 31 stub-harness asserts, 0 failures |
| M4 autostart, `openMode`, docs | done; `chrome-app` open path implemented but untested, README + `INSTALL.md` line 5 added (needs a `v1.2.0` tag before it installs from GitHub) |

Beyond the plan: mutating routes got a same-origin guard (finding 10 in the build log),
provisioning validates the generated layer with `--dump-config` before any start, an empty
provider catalog is skipped with a warning, and the launcher is resolved with exact-version
preference plus a one-click matching-CLI install.

Your next five minutes: open **Fleet** in the sidebar → *Add provider* per LLM box
(name, `http://<ip>:<port>/v1`, key, **Test endpoint** to pull the model list) → *Add
instance* per box (default provider + model) → **Start**, then **Open**. Four windows, four
models, one machine driving them.
