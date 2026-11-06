# dsh-bionic-parity-all

One DeepSeek Harness bundle that installs the **complete LM Studio Bionic parity stack** from GitHub in a single `install_bundle` action (plus two root-level specs for the account's other plugins — see [INSTALL.md](INSTALL.md), one pasted message total).

Contents (17 rows): voice input (local SenseVoice ONNX), the `dsh-bionic-bridge` adapter with three routes (`bionic-mlx`, `ollama-local`, `openrouter-cloud` + per-route diagnostics tools), macOS Computer Use (global registration), per-session Chromium via Playwright MCP, `install_skill`/`remove_skill` + external skill roots (Bionic/Codex/Claude), the `document` agent preset, and the Documents hub page. Code ships vendored inside this package; capability packages come from the npm registry (the harness blocks git-resolved subdependencies by supply-chain policy — root-level `github:` specs for career-ops and session-delete are in INSTALL.md).

Source code and verification history: [dsh-bionic-parity](https://github.com/umerkhalid204/dsh-bionic-parity) (this bundle consumes its bridge/skill/doc-ui packages as `github:…#path:` dependencies and its voice/cua/browser capability packages from npm, pinned to Harness 0.2.2-rc.1).

MIT licensed.
