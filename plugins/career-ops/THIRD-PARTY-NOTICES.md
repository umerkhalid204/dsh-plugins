# Third-party notices

## career-ops (the `runtime/` directory)

- Project: https://github.com/career-ops-hq/career-ops
- Upstream version vendored here: **1.38.0**
- Upstream commit: **b936419e9abe0e8305f26b9f0507b3e45e06819f** (2026-10-26)
- License: MIT — full text in [LICENSE.career-ops](LICENSE.career-ops)
- Copyright (c) 2026 Santiago Fernández de Valderrama

`runtime/` is **modified** upstream source, as MIT requires stating. What changed:

| Change | Why |
|---|---|
| Added `runtime/dsh-liveness.mjs` | Liveness check with no Playwright: career-ops' own `liveness-api.mjs` ATS calls, falling back to a plain fetch classified by `liveness-core.mjs`. |
| `runtime/generate-pdf.mjs` patched: `import { chromium } from 'playwright'` replaced by a lazy `launchChromium()` | So `build-cv-html.mjs` (which imports its section-locking helpers) loads without Playwright installed; a real PDF render fails with an actionable message instead of breaking module import. |
| Localized mode sets removed: `modes/{ar,da,de,es,fr,hi,id,it,ja,ko,nl,pl,pt,ru,sg,tr,ua,vi,zh,zh-TW}` | Package size. Copy them back from an upstream checkout into `runtime/modes/` and set `language.modes_dir` in your `config/profile.yml`. |
| Playwright-dependent scripts removed: `check-liveness.mjs`, `browser-extract.mjs`, `generate-pdf`'s callers (`scan-interamt`, `scan-dayforce`, `img-to-pdf`, `archive-posting`), `playwright.cv.config.mjs` | No Playwright in the plugin. |
| Standalone-LLM evaluators removed: `gemini-eval.mjs`, `openai-tailor.mjs`, `batch-evaluate-gemini.mjs`, `scan-hn.mjs` | Harness runs the evaluation itself; those scripts pulled `@google/generative-ai` / extra keys. |
| CI and self-update tooling removed: `test-all.mjs`, `*-tests.mjs`, `update-system.mjs`, `doctor.mjs`, `validate-*-coverage.mjs`, `seed-fixture.mjs`, plus `tests/`, `docs/`, `web/`, `dashboard/`, `evals/`, `fonts/`, `examples/` | Upstream's updater and Playwright-based doctor do not belong inside a plugin; the plugin's `career_ops setup` action covers doctor's prerequisite checks. |
| `runtime/tracker-aliases.json`, `templates/`, `config/*.example.*`, `seeds/`, `data-static/`, `providers/`, `lib/`, `plugins/` (engine only adapters removed), `batch/` kept | Required by the scripts the `career_ops` tool runs. |

`runtime/node_modules/` is not committed; `js-yaml` and `dotenv` are declared as
package dependencies and installed by the package manager.

## npm dependencies

| Package | Version vendored during development | License |
|---|---|---|
| `js-yaml` | 4.3.2 | MIT — (The MIT License) Copyright (C) 2011-2015 by Vitaly Puzrin |
| `dotenv` | 18.0.9 | BSD-2-Clause — Copyright (c) 2015, Scott Motte |
| `argparse` (dependency of `js-yaml`) | 2.0.1 | Python-2.0 |

## DeepSeek Harness

`dsh-career-ops` uses public Harness plugin APIs (`ctx.tools`, `ctx.skills`,
`ctx.commands`, `ctx.webServer`, Client slots, theme tokens). It is not affiliated
with or endorsed by DeepSeek.
