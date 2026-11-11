# Install on any computer — one pasted message

Open any chat in that computer's DeepSeek Harness (Desktop or Web) and send exactly this:

```
Install five bundles with plugin_manager (action install_bundle), one per line, in order, then report each application stage and any warnings:
1. target: github:umerkhalid204/dsh-plugins#path:plugins/parity-all&v1.3.0
2. target: github:umerkhalid204/dsh-plugins#path:plugins/local-llm&v1.3.0
3. target: github:umerkhalid204/dsh-plugins#path:plugins/career-ops&v1.3.0
4. target: github:umerkhalid204/dsh-plugins#path:plugins/session-delete&v1.3.0
5. target: github:umerkhalid204/dsh-plugins#path:plugins/fleet&v1.3.0
```

Line 1 installs the full Bionic-parity stack (voice, the `openrouter-cloud` route + `openrouter_bridge_status` diagnostics, Computer Use, browser control, skills install + external skill roots, Document preset, Documents page). Line 2 adds the **local-llm** engine layer: LM Studio (MLX), Ollama, Lemonade and generic OpenAI-compatible engines as first-class provider routes with Settings-models cards, endpoint editing, model discovery, catalog enrichment, and the `local_models scan/use/use/ping/settings` tool. Lines 3–4 add career-ops and session-delete. Line 5 adds **fleet**: a profile switcher that runs several concurrent DSH hosts (each with its own `DSH_HOME`, port and default provider) and, on top of that, **orchestration** — one task fanned out across every LLM engine on your network, including boxes that do not run DSH (`@fleet` / `/fleet`, with a Host-verified gate, a one-time bench of each engine and a `plan` that can honestly answer "Solo"). All live in this repo as path fragments.

Tag `v1.3.0` is the current release: fleet **0.1.16**, parity-all 1.0.2 (with its three vendored sub-package manifests now committed — without them the umbrella's host rows do not project), local-llm 0.3.0, career-ops 1.0.4, session-delete 1.0.2.

Requirements: a Harness at 0.2.2-rc.1 (the `@deepseek-ai/*` pins; bump and re-tag when your Harness moves) and network access to GitHub + npm.

## Per-machine after-install

1. Reload the page.
2. Bridge: start Bionic/LM Studio's local server → run `bionic_bridge_status probe` → adjust the `models` list on the `bionic-bridge` row for that machine's downloads (live `/v1/models` discovery merges automatically while the server runs).
3. Cloud: store `OPENROUTER_API_KEY` in the credentials store (Models page), then `openrouter_bridge_status selftest`.
4. macOS: grant Accessibility + Screen Recording to *DSH Computer Use.app* when the permission page prompts.
5. Browser: tools attach to **new** sessions; set `executablePath` on the `bionic-browser-playwright` row if Chrome is elsewhere (defaults resolve per platform: macOS/Windows/Linux Chrome paths).
6. Voice: first recording offers "Download and prepare" (~1 GB; offline afterwards).
7. career-ops: set your `dataRoot` per machine (Settings → Plugins → career-ops → Configure).
8. fleet: open the **Fleet** sidebar page. It needs a `dsh` CLI matching the app version — the page checks it and the **Install matching CLI** button runs `npm install --prefix ~/.dsh/fleet/cli @deepseek-ai/dsh@<app version>` if it is missing or older. Then add one provider row per LLM box (**Test endpoint** fills the model list from `/v1/models`), add one instance per box, and press Start → Open. Instances live under `~/.dsh-fleet/<id>` with their own port; `~/.dsh/fleet/{logs,state,patches}` holds what the switcher owns.

## Upgrades

Commit to this repo, tag a new release (e.g. `v1.1.0`), and bump the version in the pasted message. The same three lines then upgrade any machine. To install individual bundles instead of the umbrella, use the `path:plugins/parity-bundles/<name>` specs — same mechanics.
