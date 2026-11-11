# Fleet orchestration — design draft (no code yet)

Goal: when a new task arrives, use **all** the boxes in the fleet instead of one.
Three requirements from umerk:
1. break the problem into chunks, judge each box's capability, assign chunks, run in parallel;
2. make it **optional** — DSH analyses the task, then *pauses and asks* (split across machines / stay on this one);
3. whenever split is chosen, run a **small test on each box against this task first**, then split according to the measured capability.

## 0. Facts this design stands on (all verified in this workspace)

- `list_subagent_models` on this Host returns exactly one local engine route: `strata — Strata-RTX3090`. Registered routes overall: `deepseek-official, deepseek-account, strata, openrouter-cloud, lmstudio, ollama, lemonade`. **`strata-107` is in the fleet registry but is not a provider route on this Host** — the agent cannot route a turn there today. This is the single missing bridge; everything else builds on it.
- `subagent` takes `provider` + `model` (+ `reasoning_effort`). So cross-computer parallelism *inside one conversation* is already a supported primitive — once every box is a route.
- The fleet plugin already resolves `apiKeyRef` through the credentials service (`resolveKey()`), so it can authenticate to every box's OpenAI-compatible endpoint on its own. Direct HTTP fan-out needs no new secrets.
- Members are real DSH hosts (`:3101/:3102/:3103`) with their own `DSH_HOME`, sessions, storages. Their web surface is token+cookie gated; a **headless "run this task on that host" API is unproven** (private surface, version-gated).
- Physical reality: the other boxes have their **own filesystems**. Your repo is not shared unless we move it (git, or ship the chunk's files in the prompt). Any cross-box code work needs an explicit artifact channel.
- Throughput reality: a consumer GPU does **not** scale with concurrency — 2–4 parallel requests on one 3090 make each one slower. Parallelism across *boxes* is the win; parallelism *within* a box is not.
- Model families here differ on purpose: `iq3_s` (.108), `iq3_xxs` (.107), Qwen3.8-27B-MLX (Mac). Different families ⇒ different blind spots, which is an asset for author/critic stages.

## 1. Three ways to put a chunk on another computer

| | R1 — direct model fan-out | R2 — pinned subagent (this machine) | R3 — remote DSH agent (other computer) |
|---|---|---|---|
| what runs | plugin → `POST /v1/chat/completions` on N boxes concurrently | Harness `subagent({provider:'strata-107', model:'iq3_xxs'})` | a full DSH session on the other box, driven headlessly |
| worker tools | none (sees only what we ship in the prompt) | full DSH tools on **this** Mac (read/edit/bash) | full DSH tools on **that** box (its own repo copy) |
| context budget | what we fit into that window | that model's window, inside the Lead's orchestration | that model's window, plus its own session log |
| cost/risk | lowest; deterministic; text in → text out | low; already supported; writes stay local | highest: unproven API, code shipping, merge conflicts |
| best for | map-style chunks: analysis, review, drafting, enumerating, alternatives, test-case lists | chunks that must touch files here | genuinely independent sub-projects per box |

**Recommendation: build the shared pipeline (plan → ask → bench → schedule → collect → merge) and wire R1 + R2 through it now; spike R3 as its own milestone.** R1+R2 already deliver "all computers working at once"; R3 changes *where* work happens and should not gate the rest.

## 2. The pipeline (six stages)

**Division of labour is the core design decision:** *semantic* splitting is an LLM job (the Lead writes the chunk DAG); *logistics* (validation, capability measurement, scheduling, budgets, merge hygiene) is a deterministic plugin job. Heuristics never decide what a chunk *means*; the model never decides which box is *fastest*.

1. **Sketch.** The Lead emits a typed DAG: `{id, title, kind, inputs: [file|symbol|url|chunkId], outputs: {schema|path|diff}, estimateTokens, canFail: bool, needsTools: bool}`. Written to `~/.dsh/fleet/runs/<id>/plan.json`.
2. **Parallelizability check (Amdahl honesty).** Plugin computes critical path vs total work and the *estimated makespan* per candidate schedule. Default rule: only offer the split when `estMakespan ≤ 0.7 × soloEstimate`. When it can't, the answer is "stay solo, here's why" — the gate must be allowed to talk you out of it, otherwise the feature trains you to distrust it.
3. **Gate (your #2).** A card: 3–6 chunks, proposed box per chunk with measured numbers, ETA, risk flags (conflicts, oversized context, unverified window), and the recommended action. Answers: `Split` / `Solo` / `Adjust`. Policy per task class is remembered (`gate: ask | auto | off`, plus `minSpeedup`).
4. **Capability probe (your #3)** — only when split is chosen.
   - *Free facts:* contextWindow, maxTokens, declared `reasoningEfforts`, input modalities, key present, liveness, version.
   - *Throughput:* tiny completion → tokens/sec and TTFT (this is the number that actually decides chunk assignment).
   - *Task-shaped micro-bench:* three items **generated from the actual task** — (a) instruction-following carrying the task's real constraints, (b) a small code/symbolic item in the task's language, (c) a reasoning item with a checkable answer. Run all boxes concurrently, hard budget ~15 s, score = correctness × speed. Cache 24 h per (model, task-shape); `rebench` forces a redo.
5. **Schedule.** Capability → **role**, then LPT bin-packing (largest chunk to fastest box) under constraints: `perBoxConcurrency = 1`, chunk input ≤ 60% of that box's window (ship a *pruned* brief per chunk: only the files its chunk touches), output caps from measured `tok/s × maxWallClock`. Any box that misses its cap is cancelled and its chunk reclaimed by the Lead.
6. **Collect & merge.** Each chunk returns a typed artifact (JSON per schema, or `unified diff + file list`). One integrator (the Lead, or the strongest box) merges; the plugin **enforces disjoint write scopes** and refuses a plan where two writers touch one file. Then a deliberate **cross-family review** (author ≠ reviewer's model family). Keep `predicted vs actual` makespan in the run record — that's how the estimator gets better instead of staying fiction.

## 3. Chunk taxonomy (this is where the intelligence lives)

Never "split the text into N parts". Split by *dependency shape*:

- **map / fan-out** — same operation over N independent items (per-file review, per-module docs, N alternatives). Near-linear speedup; the default proof that the feature works.
- **stage-parallel pipeline** — design → implement → test → review, parallel *within* each stage, barrier between stages.
- **race (best-of-N)** — one hard chunk to 2–3 boxes, a judge picks/merges. This is the honest answer to "only the 3090 is smart": let the cheap boxes generate candidates, let the strong box judge.
- **escalation ladder** — `iq3_xxs` attempts first; below a score threshold the same chunk re-queues to `iq3_s`. Cheap boxes absorb the easy 70%.
- **adversarial pair** — author on one family, attacker on another (Qwen MLX reviewing an `iq3_s` design finds different things).
- **speculative prep** — a fast box pre-summarises files, builds test stubs, or indexes logs *while* the strong box works the hard chunk. This is what stops the small boxes idling during serial phases.

## 4. Role vocabulary (derived from measurement, not hard-coded IQ claims)

| role | selected by | typical box today |
|---|---|---|
| Synthesizer / architect | largest usable window + best reasoning item | `iq3_s` (.108, 524k) |
| Coder | best code micro-bench, good window | Qwen3.8-27B-MLX (Mac) |
| Mechanic | highest `tok/s`, weakest scores | `iq3_xxs` (.107) — enumeration, renames, boilerplate, test-case expansion, log summaries |
| Critic | must differ from author's family | Mac vs .108, or .108 vs Mac |
| Judge | strongest available, only for race/escalation | `iq3_s` |

## 5. Config surface sketch

```yaml
orchestration:
  gate: ask            # ask | auto | off
  minSpeedup: 1.4      # only propose a split past this
  maxParallel: 4
  perBoxConcurrency: 1
  bench: { budgetMs: 15000, ttlHours: 24, items: [constraints, code, reasoning] }
  limits: { chunkWallClockMs: 240000, chunkOutputTokens: 4000, contextFill: 0.6 }
  merge: { requireDisjointWrites: true, crossFamilyReview: true }
  roles: {}            # optional pins: role -> provider/model
```

## 6. Visibility

`~/.dsh/fleet/runs/<id>/{plan.json,bench.json,schedule.json,chunks/<n>.json,merge.md,run.log}`. Client drawer: chunk bars with live `tok/s`, per-box cancel, and a run-history view (predicted vs actual makespan). Run state lives in files so a context-limit restart can resume an in-flight run — read `runs/<id>/` instead of re-planning.

## 7. Milestones

- **M0 — make the fleet routable (½ day, biggest unlock).** "Publish registry to this Host": emit the provider list into this Host's `llm-pi-ai` routes (or a `--patch` we announce). Acceptance: `list_subagent_models` shows 4 routes; a `subagent` call on `strata-107` returns text.
- **M1 — `fleet action=bench`.** fingerprint + liveness + `tok/s` + task-shaped micro-bench, cached; numbers in the panel.
- **M2 — `fleet action=plan`.** DAG validator + parallelizability estimate + the gate card. No execution; you approve/solo/adjust.
- **M3 — `fleet action=run`.** R1 concurrent fan-out for map-style chunks + artifact collection + merge contract. Lead drives R2 chunks with pinned subagents.
- **M4 — R3 spike.** Discover a headless way to start a turn on a member host (CLI flag, `/api` surface, or a worker plugin baked into provisioned profiles); git branch/patch channel for code; remote worker returns a diff, never edits your working tree.

## 8. Honest limits (worth stating before we build)

- A 3-item micro-bench ranks boxes *coarsely*; it predicts "can it follow this task's constraints", not "is it clever". Don't dress the number up as IQ.
- `iq3_*` naming suggests different quants of related models — scores across quants are noisy; `contextWindow: 524288` on `iq3_xxs` is still an assumption to probe.
- Shipping the shared brief costs tokens; on small-window boxes the brief can dominate the budget. The estimate shows this, and the gate can say "solo".
- Expect the gate to answer **"solo" often** for single-threaded coding tasks (60–80 % of such work is sequential). Fleet wins on map-style work, research/writing, reviews, test expansion, refactors across many files, and alternative generation.
- Four boxes on a LAN + one flaky endpoint can hang a run: every chunk needs a hard wall-clock cap and a fallback owner (the Lead).

## 9. Decisions (locked 2026-11-07, umerk)

1. **Routes:** R1+R2 first. R3 (remote headless agents) stays a later spike.
2. **Workloads:** all five — code features/refactors, review/critique/audit, research & long-form writing, test generation & data/log crunching, brainstorming/alternatives.
3. **Code channel:** workers return **diffs**; the Lead applies them locally. One working tree (this Mac).
4. **Gate:** **ask every time**, always with estimates.

### 9.1 What decision 1 + 3 mean together (the reframe)
With R1/R2 and diff-return, the other computers contribute **brains, not disks**. A remote box never sees your filesystem; it sees exactly the context we ship it and returns a patch or a JSON artifact that the Lead applies and tests here. Consequences we design for:

- **Context fit is a first-class scheduling constraint.** Before a code chunk is assigned, the plugin computes `bytes(chunk's files + brief)` against `0.6 × contextWindow` of the candidate box. A chunk that doesn't fit is *re-cut smaller* or assigned to the big-window box — never silently truncated.
- **Diff quality ≈ shipped-context quality.** A box reviewing a function it has never seen the imports of will confidently invent breakage. The plan must carry, per chunk, the *closure* the chunk needs (file + its direct dependencies/symbols), and the chunk spec states its assumption boundary so the reviewer can flag "insufficient context" instead of hallucinating — `insufficientContext: true` is a valid, non-failing result.
- **M0 changes from convenience to prerequisite.** Without `strata-107` and the Mac registered as *real* provider routes on this Host, there is no R2 and R1 has only one box. M0 is therefore the whole unlock.
- **Bench grading stays local and deterministic.** The plugin runs its own probes, ships the code, grades returned code by running it here (`git apply` into a scratch dir + test command) or by exact/regex match. No LLM judges a capability score.

### 9.2 Workload-shaped benchmark (because all five workloads matter)
A single generic bench can't rank a fleet for five workload classes, and roles must therefore be **per workload**, not global. Item library — the plugin picks 3 by detected task class, plus latency/throughput always:

| item | what it measures | grader |
|---|---|---|
| `constraint` | output discipline: "exactly these 5 JSON keys, no prose" | parse + key set |
| `grounding` | actually reads the task's real material (2–8k shipped tokens) | verifiable answer match |
| `code` | small function with expectations | run it **locally**, pass/fail |
| `coverage` | enumerate every distinct X in a log/file (test-gen, log crunching) | precision/recall vs locally computed truth |
| `divergence` | 5 genuinely different approaches (brainstorming) | distinctness scored by the Lead, not by the worker |

Stored per (box, model, workload): `score/10 · tok/s · TTFT · lastSeen`. So the panel reads: `box-107 — coverage 8/10 @ 61 tok/s · code 3/10` → it gets enumeration and test-stub work, not design.

### 9.3 Exact stage order for your requirement #3
The gate runs **before** the task-shaped bench (from cached fingerprints — cheap, no GPU load), and the bench runs **after** you answer "Split" — exactly as you specified: choose split → small test on every box in the context of *this* task → final split. The bench can also change **granularity**, not just assignment: a box measured at 60 tok/s gets more, smaller chunks; a box measured at 20 tok/s gets fewer, bigger ones. Final assignment is shown as a one-line diff from the proposal when it changed.

### 9.4 The gate card (copy we will build)
```
Fleet split?  task class: review     solo est 6m20s   fleet est 2m05s  (3.1×)
  4 chunks · write scopes disjoint ✓ · context fit: 108 38% ✓ 107 22% ✓ mac 51% ✓
  108 → synthesise + 2 files   (code 9/10, 38 tok/s)
  107 → 2 files                (coverage 8/10, 61 tok/s)
  mac → 2 files                (code 7/10, 22 tok/s)
  ⚠ box-mac endpoint last seen down 40m ago — re-probe before dispatch
[ Split ]  [ Solo ]  [ Adjust ]
```
Refusing to split is a first-class outcome: when `fleet est ≥ 0.7 × solo`, the card says so and recommends Solo.

### 9.5 M0 detail — the trap to avoid
M0 must **merge, not replace**. A `cordis.patch.yml` override of `llm-pi-ai` replaces that `config` wholesale, which would wipe `deepseek-official` and friends. So `action=publish-host` reads the live `llm-pi-ai` config, merges the fleet provider list into it, writes a backup first, applies, then verifies with `list_subagent_models` showing 4+ routes. Acceptance: a `subagent({provider:'strata-107'})` call returns text.

### 9.6 Still open after these answers
- R3 (remote *agents* with their own repos) is deferred, not cancelled; the diff contract in 9.1 is deliberately compatible with it later.
- `perBoxConcurrency: 1` will under-utilise a box that is idle-but-alive; revisit after the first runs give us real tok/s under load.
- Whether `iq3_xxs` on .107 really has a 524k window is a probe (M1), not an assumption.

## 10. Delivered — v0.1.15 (commit 37c36a7, live in this Host)

**Adjustment from umerk:** the Linux boxes run Strata, not DSH. So orchestration schedules over
**engines** (LLM endpoints) — a machine does not need DSH to take part. R1 (direct HTTP fan-out from
the plugin) covers every computer that serves an OpenAI-compatible API; `instances` stay interactive
seats. This makes **M0 (routable provider routes) optional**, not a prerequisite: R1 resolves
`apiKeyRef` itself. M0 only matters for R2 (pinned subagents).

Shipped surface: `fleet action=engines|bench|plan|run|runs|run-view` + matching
`/fleet/api/*` routes; `orchestrate.js` (~700 lines) holds estimation, local grading, the gate,
the per-engine queue and the summary. Every run writes
`~/.dsh/fleet/runs/<id>/{run.json,chunks/<id>.json,SUMMARY.md}` and `run` **always** returns the
per-computer report — the requirement "show me what each computer did" is not opt-in.

Gate enforced in the API: `run` refuses unless `gate:{asked:true,answer:"split"}`.

Two proof runs, both recorded:
- Run 1: 4/4 chunks graded FAIL. Cause: reasoning-first packs put thinking in `reasoning_content`
  and return `content:null` when the token cap is reached (`finish_reason:"length"`). Fixed by
  `starved` detection + one automatic escalation to >=1500 tokens.
- Run 2: 3/4 graded pass, 5523 tokens out, wall clock 100.9s, .107 (1 chunk, 22.4 tok/s) overlapping
  .108 (3 chunks, 85-96 tok/s). The 4th failed because the answer was truncated mid-JSON — caught by
  the local grader, not by eyeballing output.

Estimator corrections proven by measurement:
- tok/s measured while the 3090 also serves this agent's own inference read 16 tok/s; the same box
  measured 85-96 tok/s inside the run. Cache self-calibrates from run rows.
- `soloMs` was inverted (scaled the slow box up instead of normalising to the best box). After the
  fix an identical 3-chunk plan reports speedup 0.99 and `recommendSplit:false` — the gate can
  refuse a split, which is what makes its "yes" trustworthy.

Next (in order of payoff): auto-rebalance (LPT by measured busyMs) inside `plan`; parallel bench
across engines (sequential today); escalate on truncation, not only on starvation; measure prefill
separately from decode (the 0.35 factor is a placeholder); M0 `publish-host` for R2; R3 spike.
Open: the Mac's engine never participated — `open -a Strata` started a server on 127.0.0.1:47831
with no models loaded, and LM Studio is not installed here, so `lmstudio-mac` benches as `fetch failed`.

## 11. Self-contention: the orchestrator's own engine is now in the fleet (2026-11-07, umerk switch)

umerk moved this session's model to **mac-strata / q2_0** (`http://127.0.0.1:47831/v1`), so the Mac is
both the agent's brain and a schedulable engine. That changes distribution rules:

- `hostRoute()` reads `agent-default-model` from the home/profile patch (env vars are not guaranteed
  inside the plugin process, so it also scans `$DSH_HOME/profiles/*/cordis.patch.yml`), then matches
  the provider's `baseURL` authority. Engines are flagged `sharedWithHost` (same machine) and
  `isThisAgent` (same model). Verified live: `self: {provider: mac-strata, model: q2_0, host: 127.0.0.1:47831}`.
- `orchestration.selfContentionPercent` prices that contention (set to 60 in this profile). It is a
  knob, not magic: without it, plans assume the measured rate.
- Measured throughput of q2_0: **35.9 tok/s, prefill 398 tok/s**. It is the *fourth* engine, and the
  one the agent competes with — chunk wall clocks on it can overrun while the Lead is thinking.
- `lmstudio-mac` is a dead row (LM Studio not installed here); kept so MLX models can be re-added.

Measured fleet rates after the switch (same task, concurrent):
| engine | host | tok/s | verdict |
| --- | --- | --- | --- |
| strata-rtx3090 (iq3_s) | 192.168.10.108 | 79-96 | 3/3 probes pass |
| mac-strata (q2_0) | 127.0.0.1:47831 | 28-36 | 3/3 pass, prefill 398 |
| strata-107 (iq3_xxs) | 192.168.10.107 | 14-19 | 3/3 pass, but the slow box |

**Two objectives now exist and they disagree.** `balance` returns both:
- `speed` — minimum makespan (LPT). On a 3-chunk task it put 2 chunks on the 3090 and 1 on the Mac,
  makespan 39 s, leaving .107 idle.
- `spread` — use every box, accepting a larger makespan. That is what "all my computers work" means,
  and the packer reports the cost in seconds so the gate can say: *"using .107 costs +N s"*.

Decision this forces: the gate must show **makespan under both modes**, because "use all four boxes"
is a preference, not a physics law. The honest recommendation is spread for map-style work and
speed when a box is 4x slower than the fastest.

## 12. Measured capability of the three live engines (2026-11-07)

| engine | host | model | decode tok/s | prefill tok/s | probes |
| --- | --- | --- | --- | --- | --- |
| strata-rtx3090 | 192.168.10.108:47832 | iq3_s | 91-101 | ~2600 | 3/3 pass |
| mac-strata (this Mac, = the agent's own brain) | 127.0.0.1:47831 | q2_0 | 23-42 | ~420 | 3/3 pass |
| strata-107 | 192.168.10.107:47832 | iq3_xxs | 10-25 | 35-57 | 3/3 pass |
| lmstudio-mac | 127.0.0.1:1234 | - | - | - | offline, app not installed |

Prefill is the hidden variable: .107 pre-fills ~50 tok/s, so a chunk that ships 8k tokens of
code spends ~160 s just reading it before generating anything. The estimator now charges
input and output separately (`output/decode + input/prefill`), which is why `plan` sometimes says
"Solo" even when three boxes are online.

## 13. Proof run (task: audit the fleet scheduler, 3 chunks, 3 computers)

Run `1794065170458-proof-run-3-engines-measured-assignment`, wall clock 50.1 s.

| computer | model | assigned | role | result | busy | tok/s | graded |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 192.168.10.108 | iq3_s | find correctness bugs in the scheduler | critic | 3 defects w/ fixes | 18.5 s | 91.7 | pass |
| 192.168.10.107 | iq3_xxs | classify the fleet API routes | coverage | 15 routes | 50.1 s | 21.0 | FAIL (it wrote "state GET" instead of "/fleet/api/state") |
| this Mac | q2_0 | tabulate default limits with units | mechanic | 8 knobs | 9.9 s | 42.6 | pass |

Read: the slow box is the critical path (50.1 s wall clock = its chunk), and the graded FAIL is a
*real* failure caught locally, not a model opinion. That is the case for the split working: three
computers, three artifacts, one report, no machine wrote to the working tree.

Earlier comparison runs (same task): LPT-balanced 2 engines = 42.8 s wall; "use every computer" = 180 s
(the slow box timed out). Rebalancing by measured capability is not a nicety, it is the difference
between 43 s and 180 s.

## 14. v0.1.16 — the four changes umerk asked for (shipped 2026-11-07, verified live)

1. **Benching is one-time, not per-task.** `benchTtlHours` default 168 → **720 h (30 days)**, and
   freshness is now a property of a single `(engine, model)` row instead of one global `cache.at`
   (the old code let one bench refresh the timestamp for every engine, so a fresh row could force a
   global re-bench). `autoBench: true` probes **only** engines a plan names that have no fresh row —
   verified: a plan over two already-measured boxes reported
   `autoBench: { ran: true, probed: 0, cached: 2 }`. Bench runs engines **in parallel**
   (`benchConcurrency: 3`, capped at 4) and the prefill probe ships ~375 filler tokens instead of
   ~3,600 — that probe alone cost the 35 tok/s box ~100 s before.
2. **`@fleet` / `/fleet` is a real switch, verified by the Host.** The plugin listens to
   `session/event` → `user/message` and records the keyword with a timestamp per session
   (`triggerTtlMs`, default 15 min). `run()` refuses unless a live trigger exists for the calling
   session; the agent's `gate.trigger` string is no longer the authority. `/fleet` is also
   registered as a genuine slash command (`status`, `bench`, `solo`), arming the split without
   spending a model turn. Verified live: a run without the keyword was refused with *"this Host
   never saw @fleet or /fleet in a message from session …"*; `fleet action=trigger` reports
   `armed: []`.
3. **The Host's own engine is not a worker — and it now knows which one that is.**
   `excludeSelfEngine` was reading `agent-default-model` from the profile patch, which is a
   *default*, not the live selection: while this session ran on the Mac, `hostRoute()` reported the
   3090 and protected the wrong box. `selfRoute(sessionId)` now uses the model selection observed in
   that session's log (`model/selection`, `request/header`) and maps it to a registry engine.
   Verified: `self: {provider: mac-strata, model: q2_0, host: 127.0.0.1:47831}`, `isThisAgent: true`
   on that row, and a chunk assigned to it is a validation error.
4. **The idle-timeout loop.** `pi-ai stream idle timeout after 300000ms` is the adapter's stream
   watchdog (`streamIdleTimeoutMs`, default 300000) firing when no chunk arrives; `dsh-llm-retry`
   then retried a `TIMEOUT` five more times — 41 timeouts = 12,300 s of pure waiting, 44 % of the
   afternoon. The local `mac-strata` route now sets `streamIdleTimeoutMs: 900000` and
   `retryPolicy: { mode: normal, maxRetries: 1 }`, so a cold 200k-token prefill is allowed and a
   doomed request stops after one retry instead of six.

**Honest read of the split itself.** On the 3-chunk review A/B, fan-out **lost** to solo
(25.8 s on the 3090 vs 46.3 s across three boxes; the estimator said `speedup 0.89`,
`recommendSplit: false`). The gate is allowed to say Solo, and the estimator now charges prefill and
decode separately, so "split" is offered only when it is genuinely faster. A later offline run
(offline stub trigger, two live boxes) showed the opposite case: ×2 speedup, and when .107 was
simply offline the run reported `0/1 · fetch failed` for that box instead of pretending it worked —
the per-computer report is honest about a dead machine.
