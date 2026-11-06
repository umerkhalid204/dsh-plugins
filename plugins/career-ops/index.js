/**
 * career-ops for DeepSeek Harness — Host half.
 *
 * Turns the career-ops job-search system (github.com/career-ops-hq/career-ops)
 * into a Harness plugin. Three model-facing surfaces plus one UI surface, all
 * driving the same operations:
 *
 *   skill `career-ops`   the mode router (evaluate / scan / apply / tracker …),
 *                        with the vendored `modes/*.md` prompt files as its
 *                        skill resource base.
 *   tool  `career_ops`   the deterministic scripts (scan, tracker, liveness,
 *                        stats, insights) — no LLM tokens, no hand-rolled CSV.
 *   cmd   `/career-ops`  human-facing menu + live pipeline status.
 *   GET   /career-ops/api/state · POST /career-ops/api/status
 *                        the Career Ops page's data + status edit (the same
 *                        `setStatus` the tool calls).
 *
 * Layout: `runtime/` is the career-ops System Layer (vendored, English modes,
 * Playwright-free scripts). User data — cv.md, portals.yml, data/, reports/,
 * modes/_profile.md — stays in `dataRoot` from the row config, so a plugin
 * update never touches it. Every script resolves it through career-ops' own
 * `path-resolver.mjs` via CAREER_OPS_DATA_DIR.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const PKG_ROOT = import.meta.dirname
const RUNTIME = path.join(PKG_ROOT, 'runtime')
const SKILL_FILE = path.join(PKG_ROOT, 'skill', 'career-ops.md')

export const inject = ['tools']

const MAX_OUTPUT = 24_000

// --- data root -------------------------------------------------------------
//
// The row's `dataRoot` is plain config, edited in your own profile patch:
//
//   - id: career-ops
//     name: 'dsh-career-ops'
//     config: { dataRoot: '~/Job Hunt' }
//
// No `Config` schema is declared: a plugin that declares one must hand the Loader a
// validator object, and the row would fail to activate on any Harness version whose
// validator shape differs. Missing/malformed values fall back to the resolution
// order below instead.

function expandHome(value) {
  if (!value) return ''
  if (value === '~') return process.env.HOME || value
  if (value.startsWith('~/')) return path.join(process.env.HOME || '', value.slice(2))
  return value
}

/**
 * Machine-independent resolution: the row's `dataRoot` (so a laptop and a desktop
 * can point at different folders), then career-ops' own environment variables,
 * then a per-user default folder that exists nowhere else.
 */
function resolveDataRoot(config) {
  const fromConfig = expandHome(String(config?.dataRoot || '').trim())
  if (fromConfig) return path.resolve(fromConfig)
  const fromEnv = expandHome(
    String(process.env.CAREER_OPS_DATA_DIR || process.env.CAREER_OPS_ROOT || '').trim(),
  )
  if (fromEnv) return path.resolve(fromEnv)
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (home) return path.join(home, 'career-ops')
  return null
}

// --- career-ops file helpers ----------------------------------------------

const TRACKER_COLUMNS = ['#', 'Date', 'Company', 'Role', 'Score', 'Status', 'PDF', 'Report', 'Notes']

function trackerPath(dataRoot) {
  const canonical = path.join(dataRoot, 'data', 'applications.md')
  if (fs.existsSync(canonical)) return canonical
  const legacy = path.join(dataRoot, 'applications.md')
  return fs.existsSync(legacy) ? legacy : canonical
}

function splitTableRow(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/** Canonical career-ops tracker → plain rows for the tool, the page, the command. */
function readTracker(dataRoot) {
  const file = trackerPath(dataRoot)
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { file, exists: false, rows: [] }
  }
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue
    const cells = splitTableRow(line)
    if (!cells.length || cells.every((c) => !c || /^-+$/.test(c))) continue
    if (cells[0] === '#' || cells[0].toLowerCase() === 'number') continue
    if (!/^\d+$/.test(cells[0])) continue
    const row = {}
    cells.forEach((cell, i) => {
      row[(TRACKER_COLUMNS[i] || `col${i}`).toLowerCase()] = cell || ''
    })
    rows.push(row)
  }
  return { file, exists: true, rows }
}

/** data/pipeline.md — the evaluation inbox career-ops and scan.mjs share. */
function readPipeline(dataRoot) {
  const file = path.join(dataRoot, 'data', 'pipeline.md')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { file, exists: false, pending: [], blocked: [], done: 0 }
  }
  const pending = []
  const blocked = []
  let done = 0
  for (const line of text.split('\n')) {
    const item = line.match(/^\s*-\s*\[( |x|!)\]\s*(.+)$/)
    if (!item) continue
    const url = item[2].split(/\s+[—-]\s/)[0].trim()
    if (item[1] === 'x') done += 1
    else if (item[1] === '!') blocked.push({ url, line: item[2].trim() })
    else pending.push({ url, line: item[2].trim() })
  }
  return { file, exists: true, pending, blocked, done }
}

function appendPipelineUrl(dataRoot, url) {
  const file = path.join(dataRoot, 'data', 'pipeline.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    text = '# career-ops pipeline\n\n## Pending\n'
  }
  if (text.includes(url)) return { file, added: false, reason: 'already queued' }
  const line = `- [ ] ${url}`
  const heading = text.match(/^##+\s*Pending\s*$/im)
  if (heading) {
    const at = (heading.index ?? 0) + heading[0].length
    text = `${text.slice(0, at)}\n${line}${text.slice(at)}`
  } else {
    text = `${text.trimEnd()}\n\n## Pending\n\n${line}\n`
  }
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
  return { file, added: true }
}

/** Add a tracker row without an evaluation (career-ops `N/A` score sentinel). */
function addTrackerRow(dataRoot, entry) {
  const file = trackerPath(dataRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const current = readTracker(dataRoot)
  const nextNumber = current.rows.reduce((max, row) => Math.max(max, Number(row['#']) || 0), 0) + 1
  if (!current.exists) {
    const header = `# Applications Tracker\n\n| ${TRACKER_COLUMNS.join(' | ')} |\n|${TRACKER_COLUMNS.map(() => '---').join('|')}|\n`
    fs.writeFileSync(file, header)
  }
  const cells = [
    String(nextNumber),
    entry.date || new Date().toISOString().slice(0, 10),
    entry.company || '?',
    entry.role || '?',
    entry.score || 'N/A',
    STATES.includes(entry.status) ? entry.status : 'Evaluated',
    entry.pdf || '—',
    entry.report || '—',
    (entry.note || 'added by career-ops plugin').replace(/\|/g, '/'),
  ]
  const rowLine = `| ${cells.join(' | ')} |\n`
  const fd = fs.openSync(file, 'a')
  try {
    fs.writeSync(fd, rowLine)
  } finally {
    fs.closeSync(fd)
  }
  return { file, row: Object.fromEntries(TRACKER_COLUMNS.map((c, i) => [c.toLowerCase(), cells[i]])) }
}

/**
 * One status change, shared by the tool and the page's status control.
 * Delegates to career-ops' canonical writer (`set-status.mjs`) so states stay
 * validated against states.yml and the status ledger keeps its `source` column.
 */
async function setStatus(dataRoot, { entry, state, note, report, force }) {
  if (!state) return { ok: false, error: 'state is required' }
  const args = []
  if (report) args.push('--report', String(report))
  args.push(String(entry ?? ''))
  args.push(state)
  if (note) args.push('--note', String(note))
  if (force) args.push('--force')
  const run = await runScript(dataRoot, 'set-status.mjs', args.filter(Boolean))
  return run.ok
    ? { ok: true, entry: entry ?? `report ${report}`, state, output: clip(run.stdout) }
    : { ok: false, error: clip(run.stderr || run.stdout || `set-status.mjs exited ${run.code}`) }
}

function setupStatus(dataRoot) {
  const check = (rel) => {
    const abs = path.join(dataRoot, rel)
    return fs.existsSync(abs)
  }
  const required = ['cv.md', 'config/profile.yml', 'portals.yml']
  const personalization = ['modes/_profile.md', 'modes/_brief.md', 'modes/_custom.md']
  const store = ['data/applications.md', 'data/pipeline.md', 'reports']
  const missing = required.filter((rel) => !check(rel))
  const notPersonalized = personalization.filter((rel) => !check(rel))
  return {
    dataRoot,
    ready: missing.length === 0,
    missing,
    notPersonalized,
    store: store.filter((rel) => check(rel)),
    note: missing.length
      ? 'Onboarding first: create cv.md, config/profile.yml and portals.yml (career-ops `intake`/`interview` modes, or ask the agent to write them from your CV).'
      : notPersonalized.length
        ? 'Files exist but modes/_profile.md and modes/_brief.md are still the shipped template: evaluations would score against the template author\'s targeting. Offer to personalize them from cv.md first.'
        : 'Setup looks complete.',
  }
}

// --- script runner ---------------------------------------------------------

function clip(text) {
  const value = String(text ?? '')
  return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n… [truncated]` : value
}

function runScript(dataRoot, script, args = [], { timeoutMs = 240_000 } = {}) {
  const file = path.join(RUNTIME, script)
  if (!fs.existsSync(file)) return Promise.resolve({ ok: false, code: -1, stdout: '', stderr: `runtime script not found: ${script}` })
  const env = { ...process.env }
  if (dataRoot) env.CAREER_OPS_DATA_DIR = dataRoot
  env.CAREER_OPS_ROOT = dataRoot || env.CAREER_OPS_ROOT || ''
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: RUNTIME, env })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      stderr += `\n[timed out after ${timeoutMs} ms]`
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n${error.message}`.trim() })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout: clip(stdout), stderr: clip(stderr) })
    })
  })
}

const INSIGHT_SCRIPTS = {
  upskill: ['upskill.mjs', ['--summary']],
  closing_soon: ['closing-soon.mjs', ['--summary']],
  patterns: ['analyze-patterns.mjs', []],
  calibrate: ['calibrate.mjs', ['--summary']],
  funnel_velocity: ['funnel-velocity.mjs', ['--summary']],
  salary_gap: ['salary-gap.mjs', ['--summary']],
  followups: ['followup-cadence.mjs', []],
  reposts: ['detect-reposts.mjs', ['--summary']],
  repost_check: ['precheck-duplicate.mjs', []],
  health: ['verify-pipeline.mjs', []],
}

/**
 * career-ops' canonical tracker states, read from `templates/states.yml` — the single
 * source of truth that `set-status.mjs` validates against. The plugin must never
 * advertise a state that file does not define: an option the validator rejects is a
 * control that fails in the user's hands.
 */
const FALLBACK_STATES = ['Evaluated', 'Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP', 'Hired']
function canonicalStates() {
  try {
    const text = fs.readFileSync(path.join(RUNTIME, 'templates', 'states.yml'), 'utf8')
    const labels = [...text.matchAll(/^\s*label:\s*(.+)$/gm)]
      .map((match) => match[1].trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
    return labels.length ? labels : FALLBACK_STATES
  } catch {
    return FALLBACK_STATES
  }
}
const STATES = canonicalStates()
const STATUSES = STATES.join(' · ')

// --- activation ------------------------------------------------------------

export function apply(ctx, config = {}) {
  const resolveRoot = () => {
    const dataRoot = resolveDataRoot(config)
    return { dataRoot, error: dataRoot ? null : 'career-ops plugin has no data root. Set `dataRoot` on the plugin row config in cordis.patch.yml, or export CAREER_OPS_DATA_DIR.' }
  }

  // 1. Skill: the mode router over the vendored System Layer.
  const skills = ctx.get('skills')
  if (skills !== undefined && fs.existsSync(SKILL_FILE)) {
    let body = ''
    try {
      body = fs.readFileSync(SKILL_FILE, 'utf8')
    } catch {
      body = ''
    }
    if (body) {
      ctx.effect(() => skills.register({
        name: 'career-ops',
        description: 'career-ops job search: evaluate a pasted job posting or URL into an A-H report with a 1-5 fit score, tailor the CV, draft cover letters and outreach, scan ATS portals, and keep the applications tracker. Use when the user pastes a job URL or JD, asks about a posting, an application, an interview, a CV, or says "career-ops" or a mode name (oferta, scan, pipeline, tracker, apply, pdf, cover, interview-prep…).',
        whenToUse: 'A job posting, application, CV, interview, or hiring-company question arrives, or the user asks to scan portals, evaluate offers, track applications, or run a named career-ops mode.',
        content: body,
        source: 'runtime',
        path: SKILL_FILE,
        resourceBase: { kind: 'directory', path: RUNTIME },
        invocation: { modelInvocable: true, userInvocable: true },
      }), 'career-ops skill')
    }
  }

  // 2. Tool: the deterministic scripts, one operation for agent and page.
  ctx.effect(() => ctx.tools.register({
    name: 'career_ops',
    description:
      'Run the career-ops job-search pipeline against the configured data root. '
      + 'action=setup reports onboarding and profile state; scan reads public ATS boards into data/pipeline.md (zero LLM tokens); '
      + 'pipeline lists or queues URLs (op=list|add); tracker reads or changes data/applications.md (op=list|add|set; set uses career-ops\' validated states: '
      + `${STATUSES}); liveness checks whether a posting is still open before evaluating it; `
      + 'report_number reserves the next reports/NNN number for an evaluation report; stats returns funnel and scan totals; '
      + 'insight runs one analyzer (upskill, closing_soon, patterns, calibrate, funnel_velocity, salary_gap, followups, reposts, health). '
      + 'Evaluation, CV tailoring and outreach are NOT script work: load the career-ops skill and write the report yourself.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['setup', 'scan', 'pipeline', 'tracker', 'liveness', 'report_number', 'stats', 'insight'] },
        op: { type: 'string', enum: ['list', 'add', 'set'], description: 'for pipeline and tracker' },
        url: { type: 'string', description: 'posting URL for pipeline add, liveness, or tracker add' },
        company: { type: 'string', description: 'scan: one company board; tracker add: employer' },
        role: { type: 'string', description: 'tracker add: job title' },
        entry: { type: 'string', description: 'tracker set: tracker row number or "Company" name' },
        report: { type: 'string', description: 'tracker set: report number instead of the tracker row number' },
        state: { type: 'string', description: `tracker set: new status (${STATUSES})` },
        status: { type: 'string', description: 'tracker add: canonical state for the new row (default Evaluated). Non-canonical values are refused. For an existing row use `state`.' },
        note: { type: 'string', description: 'tracker set/add: note text' },
        score: { type: 'string', description: 'tracker add: fit score, or N/A' },
        dry_run: { type: 'boolean', description: 'scan: do not write files' },
        insight: { type: 'string', enum: Object.keys(INSIGHT_SCRIPTS) },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          data: { type: 'object' },
          output: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (args, value) => [
        { type: 'text', text: `career-ops ${(args && args.action) || ''} ${(value && value.error) ? `— ${(value.error || '').slice(0, 200)}` : '✓'}\n${clip(String((value && (value.output || JSON.stringify(value.data ?? {}, null, 2))) || '')).slice(0, 4000)}` },
      ],
    },
    isConcurrencySafe: (args) => ['setup', 'tracker', 'stats', 'insight', 'liveness', 'pipeline'].includes(args?.action) && args?.op !== 'add' && args?.op !== 'set',
    async execute(args) {
      return plain(await runAction(args || {}))
    },
  }), 'career-ops tool')

  /** Tool results must be lossless JSON: strip undefined values and NaN. */
  function plain(value) {
    try {
      return JSON.parse(JSON.stringify(value ?? null))
    } catch {
      return { ok: false, error: 'career-ops tool returned a non-serializable result' }
    }
  }

  async function runAction(call) {
      const { dataRoot, error } = resolveRoot()
      if (error) return { ok: false, action: call.action, error }
      switch (call.action) {
        case 'setup':
          return { ok: true, action: 'setup', data: setupStatus(dataRoot) }
        case 'scan': {
          const scanArgs = ['--json']
          if (call.company) scanArgs.push('--company', call.company)
          if (call.dry_run) scanArgs.push('--dry-run')
          const run = await runScript(dataRoot, 'scan.mjs', scanArgs, { timeoutMs: 600_000 })
          const pipeline = readPipeline(dataRoot)
          return { ok: run.ok, action: 'scan', output: run.stdout || run.stderr, ...(run.ok ? {} : { error: `scan.mjs exited ${run.code}` }), data: { pending: pipeline.pending.length, done: pipeline.done } }
        }
        case 'pipeline': {
          if (!call.op && call.url !== undefined) {
            return { ok: false, action: 'pipeline', error: 'pipeline needs op: "add" to queue a url, or "list" to read the queue — nothing was written.' }
          }
          if (call.op === 'add') {
            if (!call.url) return { ok: false, action: 'pipeline', error: 'url is required' }
            const added = appendPipelineUrl(dataRoot, call.url)
            return { ok: true, action: 'pipeline', data: added }
          }
          const pipeline = readPipeline(dataRoot)
          return { ok: true, action: 'pipeline', data: pipeline }
        }
        case 'tracker': {
          // A dropped or mistyped `op` must never masquerade as a read: if the
          // caller clearly meant to write, fail loudly and write nothing.
          if (!call.op && (call.company !== undefined || call.role !== undefined || call.state !== undefined || call.entry !== undefined)) {
            const given = ['company', 'role', 'state', 'entry', 'score', 'note'].filter((k) => call[k] !== undefined)
            return { ok: false, action: 'tracker', error: `tracker needs op: "list" | "add" | "set" — nothing was written. Write-intent arguments seen: ${given.join(', ') || 'none'}.` }
          }
          if (call.op === 'set') {
            const result = await setStatus(dataRoot, call)
            return { ok: result.ok, action: 'tracker', ...(result.output ? { output: result.output } : {}), ...(result.error ? { error: result.error } : {}), data: { entry: result.entry ?? null, state: result.state ?? null } }
          }
          if (call.op === 'add') {
            if (!call.company || !call.role) return { ok: false, action: 'tracker', error: 'company and role are required to add a row' }
            if (call.status !== undefined && !STATES.some((s) => s.toLowerCase() === String(call.status).toLowerCase())) {
              return { ok: false, action: 'tracker', error: `"${call.status}" is not a canonical career-ops state (${STATUSES}). A lead you have not evaluated yet belongs in the queue — use {action:"pipeline", op:"add", url}. The tracker holds rows that have a report or a stated application state.` }
            }
            return { ok: true, action: 'tracker', data: addTrackerRow(dataRoot, call) }
          }
          const tracker = readTracker(dataRoot)
          return { ok: true, action: 'tracker', data: { file: tracker.file, count: tracker.rows.length, rows: tracker.rows.slice(-40) } }
        }
        case 'liveness': {
          if (!call.url) return { ok: false, action: 'liveness', error: 'url is required' }
          const run = await runScript(dataRoot, 'dsh-liveness.mjs', [call.url], { timeoutMs: 60_000 })
          let verdict = null
          try {
            verdict = JSON.parse(run.stdout)
          } catch {
            verdict = null
          }
          return {
            ok: run.ok,
            action: 'liveness',
            data: verdict || {},
            ...(verdict ? {} : { error: run.stderr || `liveness check exited ${run.code}` }),
          }
        }
        case 'report_number': {
          const run = await runScript(dataRoot, 'reserve-report-num.mjs', [])
          return { ok: run.ok, action: 'report_number', output: run.stdout.trim(), error: run.ok ? undefined : run.stderr, data: { reserved: run.stdout.trim() } }
        }
        case 'stats': {
          const run = await runScript(dataRoot, 'stats.mjs', ['--summary'])
          return { ok: run.ok, action: 'stats', output: run.stdout || run.stderr }
        }
        case 'insight': {
          const entry = INSIGHT_SCRIPTS[call.insight]
          if (!entry) return { ok: false, action: 'insight', error: `unknown insight: ${call.insight}` }
          const [script, scriptArgs] = entry
          const extra = []
          if (call.insight === 'repost_check' && call.company) extra.push('--company', call.company, '--title', call.role || call.company)
          const run = await runScript(dataRoot, script, [...scriptArgs, ...extra])
          return { ok: run.ok, action: 'insight', insight: call.insight, output: run.stdout || run.stderr, ...(run.ok ? {} : { error: run.stderr || `${script} exited ${run.code}` }) }
        }
        default:
          return { ok: false, action: call.action, error: `unknown action: ${call.action}` }
      }
  }

  // 3. Command: the human-facing menu with live counts.
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    ctx.effect(() => commands.register({
      name: 'career-ops',
      description: 'career-ops job search: show the mode menu and the current pipeline state',
      input: { hint: '[scan | pipeline | oferta | apply | pdf | cover | tracker | stats | setup]' },
      recordInput: true,
      async handler(invocation) {
        const { dataRoot, error } = resolveRoot()
        if (error) return { kind: 'error', text: error }
        const wanted = String(invocation.rawInput || '').trim().split(/\s+/)[0].toLowerCase()
        const tracker = readTracker(dataRoot)
        const pipeline = readPipeline(dataRoot)
        const setup = setupStatus(dataRoot)
        const counts = {}
        for (const row of tracker.rows) counts[row.status || '—'] = (counts[row.status || '—'] || 0) + 1
        const tally = Object.entries(counts).map(([status, n]) => `  ${status}: ${n}`).join('\n') || '  (tracker is empty)'
        const head = [
          `career-ops — data root: ${dataRoot}`,
          `Queue: ${pipeline.pending.length} pending · ${pipeline.blocked.length} blocked · ${pipeline.done} processed`,
          `Tracker (${tracker.rows.length}):`,
          tally,
          setup.ready ? '' : `Setup missing: ${setup.missing.join(', ')}`,
        ].filter(Boolean).join('\n')
        if (!wanted) {
          return {
            kind: 'success',
            text: `${head}\n\nAsk the agent in plain language, or name a mode: evaluate this JD, scan, pipeline, oferta, ofertas, apply, pdf, text, cover, email, contacto, deep, interview-prep, interview, intake, retro, tracker, agent-inbox, triage, batch, patterns, calibrate, upskill, followup, titles, discover, offer-prep, outcome, ats.\nEvery evaluation follows career-ops' A-H blocks and 1-5 score; the agent writes reports/NNN-*.md and keeps the tracker.`,
          }
        }
        return { kind: 'success', text: `${head}\n\nRequested mode: ${wanted} — ask the agent to run it (it loads the career-ops skill and the mode file runtime/modes/${wanted}.md).` }
      },
    }), 'career-ops command')
  }

  // 4. Routes: the Career Ops page. Same operations as the tool.
  const web = ctx.get('webServer')
  if (web !== undefined) {
    const sendJson = (res, status, body) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(payload)
    }
    ctx.effect(() => web.register({
      kind: 'exact',
      path: '/career-ops/api/state',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        const { dataRoot, error } = resolveRoot()
        if (error) return sendJson(res, 200, { ok: false, error, setup: null, tracker: [], pipeline: null })
        const tracker = readTracker(dataRoot)
        const pipeline = readPipeline(dataRoot)
        return sendJson(res, 200, {
          ok: true,
          states: STATES,
          dataRoot,
          setup: setupStatus(dataRoot),
          tracker: tracker.rows,
          pipeline: { pending: pipeline.pending, blocked: pipeline.blocked, done: pipeline.done },
          reports: listReports(dataRoot),
        })
      },
    }), 'career-ops state route')

    ctx.effect(() => web.register({
      kind: 'exact',
      path: '/career-ops/api/status',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        const { dataRoot, error } = resolveRoot()
        if (error) return sendJson(res, 200, { ok: false, error })
        let raw = ''
        req.on('data', (chunk) => { raw += chunk })
        req.on('end', async () => {
          let body = {}
          try {
            body = raw ? JSON.parse(raw) : {}
          } catch {
            return sendJson(res, 400, { ok: false, error: 'body must be JSON' })
          }
          const result = await setStatus(dataRoot, body)
          return sendJson(res, 200, result)
        })
      },
    }), 'career-ops status route')
  }
}

function listReports(dataRoot) {
  const dir = path.join(dataRoot, 'reports')
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .slice(-20)
  } catch {
    return []
  }
}
