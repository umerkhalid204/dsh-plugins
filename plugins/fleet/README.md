# dsh-plugin-fleet — profile switcher and multi-instance launcher for DeepSeek Harness

Run several DSH hosts at the same time on one machine, each with its **own DSH home,
its own port, and a different default LLM provider**, and switch between them from one
place. Built for the case where your LLMs live on several boxes on your network: give
every box its own Harness, keep every provider visible everywhere, and open the one you
want to work with.

```
Desktop DSH (the switcher)                        profiles/desktop · ~/.dsh · :50658
  Fleet page / `fleet` tool  ── registry ──┐
                                          │  provision + start (detached)
   ~/.dsh-fleet/box-a/  ← DSH_HOME ── dsh --profile box-a --patch <providers> --port 3101
   ~/.dsh-fleet/box-b/  ← DSH_HOME ── dsh --profile box-b --patch <providers> --port 3102
   ~/.dsh-fleet/box-c/  ← DSH_HOME ── dsh --profile box-c --patch <providers> --port 3103
        each prints  dsh web: http://127.0.0.1:<port>/?token=…   → the Open button
```

## Why separate processes

The Desktop app holds an Electron single-instance lock (`requestSingleInstanceLock`) and
always boots the `desktop` profile, so a second Desktop window is a second *client* of the
same Host, not a second Host. Real parallel hosts are separate `dsh --profile web`
processes, and that is what this plugin creates, tracks and stops.

## Install

```sh
dsh plugin --profile desktop add github:umerkhalid204/dsh-plugins#path:plugins/fleet
```

Or from a checkout: **Plugins → Install → point at the bundle directory** (this repo's
`plugins/fleet`), or ask the agent: *"install bundles/dsh-fleet as a bundle"*.
Restart the app once so the Client half is picked up by the page.

Then open **Fleet** in the sidebar.

## The launcher (one prerequisite)

Every instance is started with a real `dsh` CLI. It must be the **same version** the
Harness app runs (plugins are admitted by exact version), so the Fleet page checks it and
says so:

- `auto` looks for `<fleet root>/cli/node_modules/.bin/dsh`, then `dsh` on `PATH`.
- On drift or absence, the page shows a red banner with the exact command, and
  **Install matching CLI** runs it for you:
  `npm install --prefix ~/.dsh/fleet/cli @deepseek-ai/dsh@<the app's version>`
- You can pin a binary instead: `launcher: /path/to/dsh`.

## What a provisioned instance is

Per instance the plugin owns three things, all under the fleet root (`~/.dsh/fleet`):

| Path | Content |
|---|---|
| `patches/<id>.llm.yml` | generated overlay: `llm-pi-ai` provider routes + `agent-default-model` |
| `logs/<id>.log` | the Host's own stdout/stderr, shown in the Logs drawer |
| `state/<id>.json` | pid, port, URL, and the registry hash recorded at provision time |

The instance's **home** (`~/.dsh-fleet/<id>` by default) holds its own `profiles/`,
`sessions/`, `storages/`, `.env` and `.credentials.yaml`. Homes are never shared, because
`profiles/<name>/lock`, the storage domains and the projection cache are home-scoped.

Startup line, exactly as the Harness prints it:

```
dsh --profile <id> --patch <fleet root>/patches/<id>.llm.yml --no-open --port <port>
```

`--patch` keeps the generated provider layer **out of the instance's own patch file**, so
editing anything inside that instance (its Settings, its models) is never overwritten by
re-provisioning.

Providers appear in **every** instance (all DeepSeek routes stay, they come from
`dsh-base`); the per-instance difference is `agent-default-model`. That is the
"all providers, different default" behaviour.

## Secrets

A provider's `apiKeyRef` is written into the generated patch as `apiKeyEnv`, and the key
value is seeded into that instance's `.env` (mode `600`) — never into YAML. `seedEnv` also
copies the parent `.env` and `.credentials.yaml` into a fresh home so a sign-in or an API
key does not have to be entered per instance. Turn `seedEnv` off for a genuinely isolated
instance. The Host strips `apiKey` from every response; the page shows only `hasKey`.

## `fleet` tool (same operations as the page)

```
fleet list
fleet save        {providers:[…], instances:[…]}      # present list replaces, omitted list is unchanged
fleet delete      {kind:"instance"|"provider", id}
fleet action      {id, op:"provision"|"start"|"stop"|"restart"|"probe-instance"|"forget"}
fleet logs        {id, limit?}
fleet probe       {baseURL, apiKey?|apiKeyRef?, vendor?}   # → models[]
fleet open-url    {id}
fleet install-runtime
```

Provider/instance rows are validated and normalized: ids become slugs, ports must be in
1025-65535 and unique, an unknown provider reference or a model that is not in a
provider's list comes back as a warning rather than a silent break.

## Verified (2026-11-06, Harness 0.2.2-rc.1, macOS)

- A provisioned instance boots and answers: status `running`, pid recorded, and the
  `dsh web: http://127.0.0.1:<port>/?token=…` line captured for the Open action.
- The token URL exchanges for a signed cookie (303 → `/`), and the authenticated root
  serves the app shell (`__DSH_BOOT__`); without it the root answers 401.
- The generated overlay passes `dsh --dump-config`, i.e. `llm-pi-ai` and
  `agent-default-model` accept it. Provisioning runs that check **before** any start, so a
  refused configuration is reported instead of appearing as a dead Host.
- Endpoint probe reads `/v1/models` (plus Ollama `/api/tags` and LM Studio
  `/api/v0/models` dialects) — verified against a live local Strata server.
- `stop` terminates the process group; status returns to `provisioned`.
- A provider with no models is left out of the generated patch with a warning, because
  pi-ai refuses a route that cannot name a model and the whole row would fail.
- Credential files must be owner-only: the copy is written `600` (a `644` copy made the
  child Host fail its required `credentials` plugin — caught by the integration harness).

## Limitations and notes

- **Plugin routes are not behind the Host's launch-token auth.** `/fleet/api/*` answers to
  anything that can reach the port — that is how every plugin route works in this Harness
  (`/career-ops/api/state` behaves the same). Because these operations launch processes and
  rewrite profile patches, mutating calls additionally require same-origin **evidence**, any
  one of: `sec-fetch-site: same-origin`; the Host's own `HttpOnly; SameSite=Strict`
  `dsh-auth-…` session cookie; or an `origin`/`referer` whose authority matches this
  listener (loopback aliases `localhost` ≡ `127.0.0.1` are equated, ports must match).
  Refusals record the headers they saw — read them at `GET /fleet/api/state` under
  `guard.rejections`. `requireSameOrigin: true` is the default (enforced); `observe` records
  the same evidence without refusing, which is how a client mismatch is diagnosed before
  tightening; `false` turns the guard off. Verified matrix (enforced): no evidence 403,
  cross-site page 403, wrong-port page 403, guessed non-`dsh-auth` cookie 403,
  `sec-fetch-site: same-origin` 200, matching `origin` 200, Host session cookie 200,
  `localhost` alias 200. The listener stays loopback unless you pass `--host`, so the
  reachable set is local.
- Re-provisioning a running instance needs a restart of that instance to take effect
  (the row is flagged `stale` until then).
- `bundles:` mirrors extra bundles into the child profile manifest, but the child home
  still needs one `dsh plugin --profile <id> install` in that home (network + git access).
- Tokens: each Host mints one process credential and **re-mints it whenever it hot-reloads**,
  printing a new `dsh web:` line; a superseded address is refused with
  `dsh web authentication required; reopen the URL printed by dsh web.` Open therefore always
  re-reads the newest line from the member's log — never reuse a copied-out URL, and after a
  re-provision expect a fresh address. A live token is reusable (each client gets its own
  `dsh-auth-<authority hash>` cookie), so opening the same member twice is fine; the bare
  root answers 401 until such a cookie exists.
- Open modes (`openMode` on the `fleet` row): `tab` is the default — the Host runs `open <url>`,
  so the member appears as one new tab in the browser you already run (the Desktop shell denies
  `window.open`, so the page cannot do this itself). `chrome-app` instead spawns a dedicated
  Chrome window (`open -na "Google Chrome" --args --app=<url>`) — it gives a chrome-less app
  window, but a second Chrome instance can bring its own startup window with it, which looked
  like a stray console-ish window. `browser` returns the URL for a page-side open (works in a
  browser-hosted DSH, not the Desktop shell); `none` does nothing.
- An Open click always re-reads the member's newest announced address (see the token note
  above), so a member that has hot-reloaded is still reachable without a restart.
- Instances do not get the Fleet plugin themselves (v1), so the switcher lives in the Host
  you launch from.
- Windows is untested here; the launcher resolution assumes POSIX paths and `SIGTERM`.

## Configuration (the `fleet` row)

```yaml
- id: fleet
  name: dsh-plugin-fleet
  config:
    root: ~/.dsh/fleet          # logs, state, generated patches
    homeRoot: ~/.dsh-fleet      # parent of instance homes
    launcher: auto              # or an absolute dsh path
    portBase: 3101
    requireVersion: true        # surface launcher/host version drift
    requireSameOrigin: true     # guard for mutating routes
    openMode: browser           # browser | chrome-app | none
    autostartOnBoot: false      # start instances flagged autostart
    startTimeoutMs: 90000
    probeTimeoutMs: 5000
    providers: [...]            # shared catalog, edited from the page
    instances: [...]            # one row per DSH host
```

`providers` and `instances` are declared volatile, so saving the registry updates them in
place instead of remounting the plugin — a save can never tear down the Hosts it manages.
