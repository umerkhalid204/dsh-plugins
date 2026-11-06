# Changelog

## 1.0.4 — 2026-10-27

- **Bug fix — wrong state vocabulary.** The tool and the Career Ops panel offered
  `Pending` / `Sourced`, which career-ops does not define, and omitted `Responded`,
  `Assessment`, `SKIP`, `Hired`. Any change through those options failed at
  `set-status.mjs`, so the panel's control was broken for four of its nine entries.
  The state list is now read from career-ops' `templates/states.yml` (the same file
  `set-status.mjs` validates against), served to the page as `/career-ops/api/state`
  → `states`, and used by the tool description, its `state`/`status` parameters and the
  panel's chips and dropdown. A hard-coded copy remains only as an offline fallback.
- `tracker op:"add"` now refuses a non-canonical `status` and points at
  `{action:"pipeline", op:"add"}` for leads that have not been evaluated, instead of
  writing a row no state transition can ever leave.

## 1.0.3 — 2026-10-27

- **Bug fix:** `career_ops {action:"tracker", op:"add"}` silently fell back to a list read when the
  call carried `status` — that property was missing from the tool's parameter schema, and with
  `additionalProperties: false` the arguments were dropped before execution. `status` is now declared
  (initial status for a new row; `state` stays the field for changing an existing row).
- Write-intent calls that arrive without a recognised `op` now fail loudly instead of reading:
  `tracker` errors when company/role/state/entry are present without `op`, and `pipeline` errors when
  `url` is present without `op`. Nothing is written in either case.

## 1.0.2 — 2026-10-26

- Ship the DACH market mode set (`runtime/modes/de`) so `language.modes_dir: modes/de` works:
  German evaluation/apply vocabulary (Angebot/bewerben, 13. Monatsgehalt, Probezeit,
  Kündigungsfrist, Tarifvertrag, AGG). Refreshed the rest of the runtime from upstream 1.38.0.

## 1.0.1 — 2026-10-26

- `LICENSE` is now pure MIT so GitHub's license detector reads it (the career-ops
  attribution and the list of modifications live in THIRD-PARTY-NOTICES.md, as before).

## 1.0.0 — 2026-10-26

First published build: career-ops as a DeepSeek Harness plugin.

- Bundle `dsh-career-ops` with one Loader row, `career-ops`.
- Skill `career-ops`: the mode router (auto-pipeline, oferta, scan, pipeline, apply,
  pdf, cover, tracker, interview-prep, triage, patterns, upskill …), with the vendored
  System Layer as its resource base.
- Tool `career_ops`: `setup`, `scan`, `pipeline`, `tracker` (list/add/set), `liveness`,
  `report_number`, `stats`, `insight` — one implementation shared with the UI.
- Command `/career-ops`: mode menu plus live queue and tracker counts.
- Career Ops panel: sidebar row, central page with funnel cards, the applications
  tracker and a per-row status control, the pending evaluation queue, recent reports.
- `runtime/` carries career-ops 1.38.0 (`b936419e`), English modes only, with
  Playwright removed and `dsh-liveness.mjs` added — see THIRD-PARTY-NOTICES.md.
- Row config `dataRoot` is portable (`~/…` supported; falls back to
  `$CAREER_OPS_DATA_DIR` then `~/career-ops`), so one install works on every machine.
