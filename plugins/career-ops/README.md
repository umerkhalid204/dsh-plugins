# dsh-career-ops

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that brings
[career-ops](https://github.com/career-ops-hq/career-ops) — the open-source AI job-search
agent by [@santifer](https://github.com/santifer) — into Harness. Paste a posting, get a
structured A–H evaluation with a 1–5 fit score; scan public ATS boards; tailor CVs and cover
letters; keep the applications tracker — with a panel in the Harness UI, not a separate CLI.

It registers four surfaces from one Loader row, `career-ops`:

| Surface | What it is |
|---|---|
| skill `career-ops` | The mode router the agent loads for any job/application/CV/interview question, reading the prompt files in `runtime/modes/*.md`. Model- and user-invocable. |
| tool `career_ops` | The deterministic scripts: `setup`, `scan`, `pipeline`, `tracker`, `liveness`, `report_number`, `stats`, `insight`. Zero LLM tokens. |
| command `/career-ops` | Human-facing mode menu plus live queue and tracker counts. |
| **Career Ops** panel | Sidebar row + central page: funnel cards, the applications tracker with a status control per row, the pending evaluation queue, recent reports. |

The panel's status control and the tool's `tracker set` call the **same** Host operation, which
delegates to career-ops' own `set-status.mjs` — states stay validated against `states.yml`, notes
merge, and `data/status-log.tsv` keeps the transition ledger.

## Install

Requires DSH (a recent Harness release; the plugin uses the `skills`, `commands`, `tools`,
`webServer` services and the Web Client slot API) and Node ≥ 22.13 for the vendored scripts.

**In a Harness session on the machine you want it on** — the reliable path, because the plugin
manager both installs the package and selects the bundle for your profile:

> Install the bundle `git+https://github.com/umerkhalid204/dsh-career-ops.git#v1.0.1`.

Or from a terminal, to install the package into a profile:

```bash
dsh plugin --profile desktop add git+https://github.com/umerkhalid204/dsh-career-ops.git#v1.0.1
```

If you installed with `dsh plugin add` rather than through a session, also select the bundle in
**Settings → Plugins** so its `cordis.patch.yml` composes.

Then click the **Career Ops** sidebar row. If the panel or the `career-ops` skill does not appear,
reload the page (Client bundles) and toggle the `career-ops` row off/on (Host module reload).

## Point it at your job-search folder

`runtime/` is career-ops' **System Layer** and is never written to. Your data lives in `dataRoot`:
`cv.md`, `config/profile.yml`, `portals.yml`, `data/`, `reports/`, `jds/`, `interview-prep/`, and
the personalization files `modes/_profile.md`, `modes/_custom.md`, `modes/_brief.md`, `voice-dna.md`.

Resolution order, so the same install works on every machine:

1. the row's `dataRoot` — override it per machine in your own profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`),
   absolute path or `~/…`:

   ```yaml
   - id: career-ops
     name: 'dsh-career-ops'
     config:
       dataRoot: '~/Job Hunt'
   ```

   A matching `id` with no `insert` replaces that row's whole `config`, so restate every field.
2. `$CAREER_OPS_DATA_DIR` / `$CAREER_OPS_ROOT` from the Harness process environment;
3. `~/career-ops`, created on the first write.

To move a search to another computer, copy that folder — it is the whole state (files are the
canonical store; career-ops' SQLite indexes are derived and can be rebuilt).

Start a fresh search by asking the agent: *"set up career-ops"* (it writes `cv.md`,
`config/profile.yml` and `portals.yml` from your CV and answers), then paste a job URL.

## Layout

```
index.js            Host half: Config + skill + tool + command + the two API routes
client.js           Client half: sidebar icon + the Career Ops page
skill/career-ops.md the skill body (the mode router the agent loads)
runtime/            vendored career-ops System Layer (modes/, providers/, lib/, templates/, scripts)
runtime/dsh-liveness.mjs   added here: Playwright-free liveness on career-ops' own ATS APIs
scripts/refresh-runtime.mjs re-vendor the runtime from upstream
```

`runtime/node_modules` is not committed: `js-yaml` and `dotenv` are declared dependencies and are
installed with the package.

## Refreshing from upstream

```bash
node scripts/refresh-runtime.mjs                 # latest upstream
node scripts/refresh-runtime.mjs --ref v1.40.0   # a tag or commit
node scripts/refresh-runtime.mjs --modes de fr   # also ship those market mode sets
node scripts/refresh-runtime.mjs --from ../career-ops --dry-run
```

It re-applies the two plugin-side adaptations automatically and prints the upstream version and
commit to record in `THIRD-PARTY-NOTICES.md`.

## Known differences from upstream

- **No Playwright.** The `apply` form driver, `scan-interamt`/`scan-dayforce`, `archive-posting`
  and native PDF rendering need it. `runtime/generate-pdf.mjs` is patched so Playwright loads
  lazily: CV building and fact gates work, a PDF render asks you to install Playwright (or export
  through Harness). JD text comes from your paste or Harness' `web_fetch`.
- **Liveness** runs through `runtime/dsh-liveness.mjs` — career-ops' ATS-API checks plus a plain
  fetch through `liveness-core.mjs`'s classifier. `uncertain` never closes a posting.
- **English modes only** in the published package (~10 MB). Add a market with
  `--modes de` above, then set `language.modes_dir` in `config/profile.yml`.
- **No upstream self-updater** (`update-system.mjs`), no Go dashboard, no `web/` UI, no
  `gemini-eval`/`openai-tailor`, no `doctor.mjs` — `career_ops setup` covers the same checks.
- **Nothing is ever submitted.** Like upstream: it drafts, fills and renders; you press Submit.
  It recommends against applying below 4.0/5, and treats job postings as data, never instructions.

## License

MIT — see [LICENSE](LICENSE). `runtime/` is modified upstream career-ops source, MIT,
Copyright (c) 2026 Santiago Fernández de Valderrama (full text in
[LICENSE.career-ops](LICENSE.career-ops); modifications listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)). Not affiliated with DeepSeek.
