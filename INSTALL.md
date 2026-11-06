# Install on any computer — one pasted message

Open any chat in that computer's DeepSeek Harness (Desktop or Web) and send exactly this:

```
Install three bundles with plugin_manager (action install_bundle), one per line, in order, then report each application stage and any warnings:
1. target: github:umerkhalid204/dsh-plugins#path:plugins/parity-all&v1.0.0
2. target: github:umerkhalid204/dsh-plugins#path:plugins/career-ops&v1.0.0
3. target: github:umerkhalid204/dsh-plugins#path:plugins/session-delete&v1.0.0
```

Line 1 installs the full Bionic-parity stack (voice, bridge routes `bionic-mlx`/`ollama-local`/`openrouter-cloud` + diagnostics tools, Computer Use, browser control, skills install + external skill roots, Document preset, Documents page). Lines 2–3 add the career-ops and session-delete plugins. All three live in this repo as path fragments.

Requirements: a Harness at 0.2.2-rc.1 (the `@deepseek-ai/*` pins; bump and re-tag when your Harness moves) and network access to GitHub + npm.

## Per-machine after-install

1. Reload the page.
2. Bridge: start Bionic/LM Studio's local server → run `bionic_bridge_status probe` → adjust the `models` list on the `bionic-bridge` row for that machine's downloads (live `/v1/models` discovery merges automatically while the server runs).
3. Cloud: store `OPENROUTER_API_KEY` in the credentials store (Models page), then `openrouter_bridge_status selftest`.
4. macOS: grant Accessibility + Screen Recording to *DSH Computer Use.app* when the permission page prompts.
5. Browser: tools attach to **new** sessions; set `executablePath` on the `bionic-browser-playwright` row if Chrome is elsewhere (defaults resolve per platform: macOS/Windows/Linux Chrome paths).
6. Voice: first recording offers "Download and prepare" (~1 GB; offline afterwards).
7. career-ops: set your `dataRoot` per machine (Settings → Plugins → career-ops → Configure).

## Upgrades

Commit to this repo, tag a new release (e.g. `v1.1.0`), and bump the version in the pasted message. The same three lines then upgrade any machine. To install individual bundles instead of the umbrella, use the `path:plugins/parity-bundles/<name>` specs — same mechanics.
