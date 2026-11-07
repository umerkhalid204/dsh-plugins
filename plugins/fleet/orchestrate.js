import { homedir } from 'node:os'

/*
 * Fleet orchestration (R1: direct engine fan-out).
 *
 * A computer does not have to run DSH to take part. What gets scheduled is an
 * *engine* — an OpenAI-compatible endpoint (Strata, llama.cpp, LM Studio,
 * Ollama, vLLM…) that any machine can host. DSH `instances` stay what they
 * always were: interactive seats. So: brains are borrowed from every box,
 * files never leave this Host, and each chunk comes back as an artifact
 * (JSON / text / diff) that the agent applies here.
 *
 * Division of labour, deliberately:
 *   - the agent (a language model) writes the chunk DAG — semantics;
 *   - this module validates it, measures engines, schedules, enforces the
 *     split gate, runs the fan-out, and always produces the per-computer
 *     summary. No heuristic here decides what a chunk means.
 */

const DEFAULTS = {
  contextFill: 0.6,
  fallbackContextWindow: 8192,
  fallbackTokPerSec: 15,
  fallbackPrefillTokPerSec: 400,
  perEngineConcurrency: 1,
  chunkWallClockMs: 240000,
  chunkOutputTokens: 800,
  /* Measuring an engine is setup, not a per-task ritual. A row stays valid for
   * 30 days, and every run writes its own measured tok/s back into the cache, so
   * the fleet knows its boxes after the first contact and never re-benches for
   * no reason. `rebench: true` is the manual override. */
  benchTtlHours: 720,
  /* Auto-bench fills only rows that have no measurement at all, and only for
   * the engines a plan actually names — never "every computer, every time". */
  autoBench: true,
  benchConcurrency: 3,
  // The machine this Host runs on is also the machine doing the agent's own
  // inference. Chunks there compete with thinking, so they are excluded from
  // fan-out unless the user explicitly opts in.
  excludeSelfEngine: true,
  keywords: ['@fleet', '/fleet'],
  // A trigger stops counting after this much time, so a keyword typed hours ago
  // cannot arm a fan-out that was never meant for this task.
  triggerTtlMs: 900000,
}

/* --------------------------------------------------------------- estimation */

/** Crude, but self-correcting: real usage.prompt_tokens recalibrates per engine. */
function estimateTokens(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[\u3040-\u30ff\u3400-\u4dbf\uac00-\ud7af\u4e00-\u9fff]/gu) ?? []).length
  return Math.ceil((s.length - cjk) / 3.6 + cjk / 1.1)
}

function estimateMessages(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m?.content) + 4, 8)
}

/* ------------------------------------------------------------- grading (local) */

function grade(text, expects) {
  if (!expects || typeof expects !== 'object') return { graded: false }
  const kind = String(expects.kind ?? '')
  const body = String(text ?? '')
  if (kind === 'jsonKeys') {
    let parsed
    try {
      parsed = JSON.parse(body.replace(/^```(?:json)?\s*|\s*```$/gu, ''))
    } catch (error) {
      return { graded: true, pass: false, why: `not parseable JSON (${error.message})` }
    }
    const want = Array.isArray(expects.keys) ? expects.keys : []
    const missing = want.filter((key) => !(parsed && typeof parsed === 'object' && key in parsed))
    return { graded: true, pass: missing.length === 0, why: missing.length ? `missing keys: ${missing.join(', ')}` : `${want.length} keys present`, parsed }
  }
  if (kind === 'contains') {
    const want = Array.isArray(expects.values) ? expects.values : []
    const missing = want.filter((needle) => !body.includes(String(needle)))
    return { graded: true, pass: missing.length === 0, coverage: `${want.length - missing.length}/${want.length}`, why: missing.length ? `absent: ${missing.slice(0, 8).join(', ')}` : 'all present' }
  }
  if (kind === 'regex') {
    try {
      const re = new RegExp(String(expects.pattern), String(expects.flags ?? ''))
      return { graded: true, pass: re.test(body), why: re.test(body) ? 'matched' : 'no match' }
    } catch {
      return { graded: true, pass: false, why: 'bad pattern' }
    }
  }
  if (kind === 'numberEquals') {
    const found = (body.match(/-?\d+(\.\d+)?/gu) ?? []).map(Number)
    const hit = found.some((n) => Math.abs(n - Number(expects.value)) <= Number(expects.tolerance ?? 0))
    return { graded: true, pass: hit, why: hit ? `found ${expects.value}` : `not in ${found.slice(0, 6).join(', ')}` }
  }
  return { graded: false, why: `unknown expects.kind "${kind}"` }
}

/* ------------------------------------------------------------ the orchestrator */

export function createOrchestrator(deps) {
  const { registry, resolveKey, paths, limits = {}, now = () => Date.now(), triggers = () => [] } = deps
  const runsDir = paths.runs
  const cachePath = paths.benchCache
  const opt = {
    ...DEFAULTS,
    ...limits,
    contextFill: Number.isFinite(limits.contextFillPercent) ? limits.contextFillPercent / 100 : DEFAULTS.contextFill,
    minSpeedup: Number.isFinite(limits.minSpeedupPercent) ? limits.minSpeedupPercent / 100 : 1.4,
  }

  const { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } = deps.fs
  const dirName = deps.path?.dirname ?? ((file) => String(file).split('/').slice(0, -1).join('/'))
  const joinPath = deps.path?.join ?? ((...parts) => parts.filter(Boolean).join('/').replace(/\/+/gu, '/'))

  function load(file, fallback) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return fallback
    }
  }
  function save(file, value) {
    mkdirSync(dirName(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value, null, 2))
  }
  function ensureDir(dir) {
    mkdirSync(dir, { recursive: true })
  }

  function providersByName() {
    const reg = registry() ?? { providers: [], instances: [] }
    const map = new Map()
    for (const provider of reg.providers) if (provider?.name) map.set(provider.name, provider)
    return map
  }

  function modelOf(provider, id) {
    return (provider?.models ?? []).find((m) => m.id === id || m.id === id.split('/').pop()) ?? null
  }

  async function keyFor(provider) {
    if (provider?.apiKey) return provider.apiKey
    if (provider?.apiKeyRef) return await resolveKey(provider.apiKeyRef)
    return undefined
  }

  function benchCache() {
    return load(cachePath, { rows: {} })
  }

  /** Capability fingerprint for every engine, merged with any measured numbers. */
  async function engines(sessionId = null) {
    const cache = benchCache()
    const self = selfRoute(sessionId)
    const rows = []
    for (const provider of providersByName().values()) {
      const key = await keyFor(provider)
      const authority = authorityOfUrl(provider.baseURL)
      const sharedWithHost = Boolean(self?.authority) && authorityMatch(self.authority, authority)
      for (const model of provider.models ?? []) {
        const stamp = cache.rows[`${provider.name}::${model.id}`]
        rows.push({
          engine: provider.name,
          host: authority,
          api: provider.api,
          model: model.id,
          label: model.name ?? model.id,
          contextWindow: model.contextWindow ?? null,
          maxTokens: model.maxTokens ?? null,
          reasoningEfforts: model.reasoningEfforts ?? null,
          hasKey: Boolean(key),
          local: isLocalAuthority(authority),
          sharedWithHost,
          isThisAgent: sharedWithHost && String(self?.model) === String(model.id),
          measured: stamp
            ? { tokPerSec: stamp.tokPerSec, decodeTokPerSec: stamp.decodeTokPerSec ?? null, prefillTokPerSec: stamp.prefillTokPerSec ?? null, ttftMs: stamp.ttftMs ?? null, at: stamp.at, scores: stamp.scores ?? {}, probeTokens: stamp.probeTokens ?? null }
            : null,
        })
      }
    }
    // Bench once, not every task. An engine needs a probe only if it has never
    // been measured or the measurement is older than benchTtlHours.
    const needsBench = rows
      .filter((row) => row.hasKey && (!row.measured || ageHours([row.measured.at], now()) > opt.benchTtlHours))
      .map((row) => `${row.engine}/${row.model}`)

    return {
      ok: true,
      engines: rows,
      needsBench,
      benchIsFresh: needsBench.length === 0,
      self: self?.found ? { provider: self.provider, model: self.model, host: self.authority, note: self.note } : null,
      selfProbe: self?.found ? undefined : { error: 'no agent-default-model entry readable from the profile patch', tried: self?.tried },
      cacheAgeHours: ageHours(rows.filter((r) => r.measured).map((r) => r.measured.at), now()),
      limits: opt,
    }
  }

  /* ------------------------------------------------------------- one request */

  async function chat({ provider, model, messages, maxTokens, temperature = 0.4, json = false, effort, timeoutMs }) {
    const base = String(provider.baseURL ?? '').trim().replace(/\/+$/u, '')
    if (!base) return { ok: false, error: `provider "${provider.name}" has no baseURL` }
    const key = await keyFor(provider)
    const cap = Math.min(Number(maxTokens) || opt.chunkOutputTokens, Number(model?.maxTokens) || Number(maxTokens) || opt.chunkOutputTokens)
    const started = now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || opt.chunkWallClockMs)
    let request
    if (provider.api === 'anthropic-messages') {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
      request = {
        url: `${base}/messages`,
        headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}), 'anthropic-version': '2023-06-01' },
        body: { model: model?.id, max_tokens: cap, system: system || undefined, messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: String(m.content ?? '') })) },
      }
    } else if (provider.api === 'openai-responses') {
      request = {
        url: `${base}/responses`,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: { model: model?.id, input: messages.map((m) => `${m.role}: ${String(m.content ?? '')}`).join('\n\n'), max_output_tokens: cap, ...(json ? { text: { format: { type: 'json_object' } } } : {}) },
      }
    } else {
      request = {
        url: `${base}/chat/completions`,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: {
          model: model?.id,
          messages: messages.map((m) => ({ role: m.role === 'user' || m.role === 'system' || m.role === 'assistant' ? m.role : 'user', content: String(m.content ?? '') })),
          max_tokens: cap,
          temperature,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
          ...(effort && model?.reasoningEfforts && model.reasoningEfforts !== false ? { reasoning_effort: effort } : {}),
        },
      }
    }
    try {
      const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal })
      const raw = await response.text()
      const elapsedMs = now() - started
      if (!response.ok) return { ok: false, error: `HTTP ${response.status} ${response.statusText} — ${raw.slice(0, 300)}`, elapsedMs, url: request.url }
      let data
      try {
        data = JSON.parse(raw)
      } catch {
        return { ok: false, error: `endpoint answered non-JSON: ${raw.slice(0, 200)}`, elapsedMs, url: request.url }
      }
      const text = extractText(data, provider.api)
      const reasoning = extractReasoning(data)
      const usage = data?.usage ?? data?.usage_metadata ?? {}
      const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens) || estimateTokens(text)
      const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens) || null
      const finish = data?.choices?.[0]?.finish_reason ?? data?.stop_reason ?? null
      return {
        ok: true,
        text,
        ...(reasoning ? { reasoning } : {}),
        elapsedMs,
        completionTokens,
        reasoningTokens: reasoning ? estimateTokens(reasoning) : 0,
        promptTokens,
        tokPerSec: completionTokens > 0 ? round2((completionTokens / Math.max(1, elapsedMs)) * 1000) : null,
        url: request.url,
        finish,
        // Reasoning-first packs (Strata's chat API puts thinking in
        // `reasoning_content` and leaves `content` null until it is done): with
        // a tight budget the answer never lands. Say so instead of grading "".
        ...(finish === 'length' && !text ? { starved: true } : {}),
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), elapsedMs: now() - started, url: request.url, aborted: controller.signal.aborted }
    } finally {
      clearTimeout(timer)
    }
  }

  function extractReasoning(data) {
    const candidate = data?.choices?.[0]?.message?.reasoning_content ?? data?.choices?.[0]?.reasoning_content ?? data?.reasoning
    return typeof candidate === 'string' && candidate.trim() ? candidate : ''
  }

  function extractText(data, api) {
    if (api === 'openai-responses') {
      if (typeof data?.output_text === 'string') return data.output_text
      const parts = (data?.output ?? []).flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
      return parts.map((part) => part?.text ?? '').join('')
    }
    if (api === 'anthropic-messages') return (data?.content ?? []).map((part) => part?.text ?? '').join('')
    return data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? ''
  }

  /* Which engine this agent is thinking on. Read from the profile/home patch
   * (the same layers the Harness applies), never guessed. If a fleet engine
   * shares that authority, its measured rates were taken under load and the
   * planner must not treat it as free capacity. */
  function hostRoute() {
    const candidates = []
    if (process.env.DSH_HOME) candidates.push(joinPath(process.env.DSH_HOME, 'cordis.patch.yml'))
    if (process.env.DSH_PROFILE_DIR) candidates.push(joinPath(process.env.DSH_PROFILE_DIR, 'cordis.patch.yml'))
    for (const home of [process.env.DSH_HOME, joinPath(homedir(), '.dsh')]) {
      if (!home) continue
      try {
        for (const name of readdirSync(joinPath(home, 'profiles'))) candidates.push(joinPath(home, 'profiles', name, 'cordis.patch.yml'))
      } catch {}
    }
    const tried = []
    for (const file of candidates) {
      tried.push(file)
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      if (!text) continue
      const block = text.match(/- id: agent-default-model[\s\S]{0,200}?config:\s*\n([\s\S]{0,400})/)
      if (!block) continue
      const provider = (block[1].match(/^\s*provider:\s*(\S+)/m) ?? [])[1]
      const model = (block[1].match(/^\s*model:\s*(\S+)/m) ?? [])[1]
      if (!provider) continue
      let baseURL = ''
      const listForm = text.match(new RegExp(`- name: ${provider}\\b[\\s\\S]{0,400}?baseURL: *(\\S+)`))
      const dictForm = text.match(new RegExp(`\\b${provider}:\\s*\\n(?:\\s+[^\\n]+\\n){0,8}?\\s+baseURL: *(\\S+)`))
      baseURL = (listForm ?? dictForm ?? [])[1] ?? ''
      return { found: true, provider, model, baseURL, authority: authorityOfUrl(baseURL), file, note: baseURL ? 'read from the profile patch' : 'the patch names a provider but no baseURL line was found' }
    }
    return { found: false, tried }
  }

  /* The profile patch names a *default* model; a session can be switched to
   * another engine in the composer. The live selection is stronger evidence
   * than the default, and "the box this agent is thinking on" must mean the
   * one it is actually thinking on — otherwise the self-exclusion guard
   * protects the wrong machine. */
  function selfRoute(sessionId) {
    const hint = deps.selfHint?.(sessionId)
    if (hint?.model) {
      const index = providersByName()
      const provider = (hint.provider ? index.get(hint.provider) : null) ?? [...index.values()].find((p) => (p.models ?? []).some((model) => model.id === hint.model))
      if (provider) return { found: true, provider: provider.name, model: hint.model, authority: authorityOfUrl(provider.baseURL), source: 'live model selection for this session' }
    }
    return hostRoute()
  }

  /* --------------------------------------------------------------- capability */

  const PROBE_ITEMS = [
    {
      kind: 'constraint',
      label: 'output discipline',
      messages: [{ role: 'user', content: 'Reply with ONLY this JSON object, no prose, no code fence: {"name":"<the word fleet>","count":3,"items":["a","b","c"]}' }],
      maxTokens: 80,
      expects: { kind: 'jsonKeys', keys: ['name', 'count', 'items'] },
    },
    {
      kind: 'coverage',
      label: 'enumeration coverage',
      messages: [
        { role: 'user', content: 'List every distinct port number mentioned below, as a JSON object {"ports":[...]}, no prose. Ports appear in these lines:\n  box-3090 :3101 running pid 3877 (default strata-rtx3090/iq3_s, effort high), box-107 :3102 running pid 3874 (default strata-107/iq3_xxs, no effort), box-mac :3103 running pid 12401; the Host itself sits on http://127.0.0.1:50658 and Ollama would be 127.0.0.1:11434.' },
      ],
      maxTokens: 120,
      expects: { kind: 'contains', values: ['3101', '3102', '3103', '50658'] },
    },
    {
      kind: 'grounding',
      label: 'reads what it is shipped',
      messages: [
        { role: 'user', content: 'Read this excerpt and answer with ONLY {"ratio":"<x>"} where x is the numeric threshold for offering a split:\n"Amdahl honesty. Plugin computes critical path vs total work and the estimated makespan per candidate schedule. Default rule: only offer the split when estMakespan ≤ 0.7 × soloEstimate."' },
      ],
      maxTokens: 80,
      expects: { kind: 'contains', values: ['0.7'] },
    },
  ]

  async function bench({ items, engine, rebench = false, concurrency } = {}) {
    const probeItems = Array.isArray(items) && items.length ? items : PROBE_ITEMS
    const cache = benchCache()
    const index = providersByName()
    // `engine` accepts one name or an array; omission means every registry row.
    const wantedNames = Array.isArray(engine) ? engine : (typeof engine === 'string' ? [engine] : null)
    const wanted = wantedNames ? [...index.values()].filter((p) => wantedNames.includes(p.name)) : [...index.values()]
    if (!wanted.length) return { ok: false, error: wantedNames ? `none of ${wantedNames.join(', ')} is in the fleet registry` : 'the registry has no providers to bench' }
    const limit = Math.max(1, Math.min(concurrency ?? opt.benchConcurrency, 4))
    // Freshness belongs to one (engine, model) row, not to the whole cache: benching
    // one box never invalidates another box's measurement.
    const rowStale = (key) => rebench || ageHours([cache.rows[key]?.at], now()) > opt.benchTtlHours

    async function benchProvider(provider) {
      const models = provider.models ?? []
      if (!models.length) return { engine: provider.name, skipped: 'no models declared' }
      if (!rowStale(`${provider.name}::${models[0].id}`)) {
        return { engine: provider.name, model: models[0].id, cached: true, ...cache.rows[`${provider.name}::${models[0].id}`] }
      }
      const perModel = []
      for (const model of models.slice(0, 2)) {
        const scores = {}
        let totalTokens = 0
        let totalMs = 0
        let passed = 0
        for (const item of probeItems) {
          // Reasoning-first packs spend most of the budget thinking, so a probe
          // needs real headroom or it grades an empty answer. Never send
          // reasoning_effort here: on these packs it is a 60 s+ path.
          const outcome = await chat({ provider, model, messages: item.messages, maxTokens: Math.max(320, Number(item.maxTokens) || 380), temperature: 0, timeoutMs: Math.max(60000, Math.floor(opt.chunkWallClockMs / 3)) })
          if (!outcome.ok) {
            scores[item.kind] = { pass: false, why: outcome.error, score: 0 }
            continue
          }
          if (outcome.starved) {
            scores[item.kind] = { pass: false, why: `thinking consumed the budget (${outcome.reasoningTokens ?? '?'} reasoning tokens, finish=length, no content) — raise maxTokens`, score: 1, ms: outcome.elapsedMs, tokPerSec: outcome.tokPerSec }
            continue
          }
          const verdict = grade(outcome.text, item.expects)
          totalTokens += outcome.completionTokens
          totalMs += outcome.elapsedMs
          if (verdict.pass) passed += 1
          scores[item.kind] = { pass: Boolean(verdict.pass), why: verdict.why, score: verdict.pass ? 10 : 2, ms: outcome.elapsedMs, tokPerSec: outcome.tokPerSec }
        }
        // Throughput is split, because prefill and decode are different
        // bottlenecks: a box that eats a 20k-token brief at 200 tok/s is a
        // different proposition from one that generates at 90 tok/s. Two calls
        // with the same instruction and different input sizes give the delta.
        /* Prefill and decode are different bottlenecks, so two calls with the
         * same instruction and different input sizes give the delta. The filler
         * is deliberately small (~350 tokens): a 3,600-token filler cost a
         * 35 tok/s box ~100 s for a number that 150 tokens already measures. */
        const instruction = 'List exactly five numbered items, one word each, about parallel computing.'
        const short = await chat({ provider, model, messages: [{ role: 'user', content: instruction }], maxTokens: 200, temperature: 0, timeoutMs: 120000 })
        const long = await chat({
          provider,
          model,
          messages: [{ role: 'user', content: 'Filler to force prefill: ' + 'the quick brown fox jumps over the lazy dog. '.repeat(150) + '\n' + instruction }],
          maxTokens: 200,
          temperature: 0,
          timeoutMs: 180000,
        })
        let throughput = { ok: false }
        if (short.ok && long.ok && long.promptTokens - short.promptTokens >= 100 && long.elapsedMs > short.elapsedMs) {
          const prefill = round2((long.promptTokens - short.promptTokens) / ((long.elapsedMs - short.elapsedMs) / 1000))
          const decodeMs = short.elapsedMs - (short.promptTokens / prefill) * 1000
          throughput = {
            ok: true,
            prefillTokPerSec: prefill,
            decodeTokPerSec: decodeMs > 200 ? round2(short.completionTokens / (decodeMs / 1000)) : null,
            ttftMs: short.promptTokens > 0 ? Math.round(short.promptTokens / prefill * 1000) : null,
            shortMs: short.elapsedMs,
            longMs: long.elapsedMs,
          }
        }

        const row = {
          engine: provider.name,
          model: model.id,
          at: now(),
          scores,
          passed,
          probed: probeItems.length,
          tokPerSec: totalMs > 0 ? round2((totalTokens / totalMs) * 1000) : throughput.prefillTokPerSec ?? null,
          decodeTokPerSec: throughput.decodeTokPerSec ?? null,
          prefillTokPerSec: throughput.prefillTokPerSec ?? null,
          probeTokens: totalTokens,
        }
        perModel.push(row)
        cache.rows[`${provider.name}::${model.id}`] = row
      }
      return perModel
    }

    /* Engines are measured in parallel: each box has its own GPU, so one slow
     * box no longer makes the whole bench a serial queue. A box is still one
     * queue internally — concurrency *inside* a box is what makes it slower. */
    const results = []
    for (let i = 0; i < wanted.length; i += limit) {
      const batch = await Promise.all(wanted.slice(i, i + limit).map(benchProvider))
      for (const row of batch) results.push(...(Array.isArray(row) ? row : [row]))
    }
    cache.at = now()
    save(cachePath, cache)
    return {
      ok: true,
      bench: results,
      cached: results.filter((row) => row.cached).length,
      note: `Graded locally (parse/contains), never by a model. A row stays valid ${opt.benchTtlHours}h (30 days); only unmeasured or stale rows are re-probed, and every run writes its own measured tok/s back into this cache. tok/s decides chunk size; scores decide role.`,
    }
  }

  /* ------------------------------------------------------------------ plan / gate */

  function bestEngine(rows) {
    const ranked = rows.filter((r) => r.measured?.tokPerSec).sort((a, b) => b.measured.tokPerSec - a.measured.tokPerSec)
    return ranked[0] ?? rows[0] ?? null
  }

  function validate(chunks, sessionId = null) {
    const index = providersByName()
    const self = selfRoute(sessionId)
    const errors = []
    const warnings = []
    const seen = new Set()
    const writers = new Map()
    for (const chunk of chunks) {
      if (!chunk?.id) errors.push('a chunk is missing an id')
      if (seen.has(chunk.id)) errors.push(`duplicate chunk id "${chunk.id}"`)
      seen.add(chunk.id)
      if (!chunk?.prompt && !Array.isArray(chunk?.messages)) errors.push(`chunk "${chunk.id}" has no prompt/messages`)
      const provider = index.get(chunk?.engine)
      if (!provider) {
        errors.push(`chunk "${chunk.id}" names engine "${chunk?.engine}", which the registry does not define`)
        continue
      }
      if (opt.excludeSelfEngine && self?.authority && authorityMatch(self.authority, authorityOfUrl(provider.baseURL))) {
        errors.push(`chunk "${chunk.id}" is assigned to "${provider.name}", the engine this Host is already thinking on. Set orchestration.excludeSelfEngine: false to allow it, or move the chunk to another box.`)
        continue
      }
      const model = modelOf(provider, chunk?.model ?? provider.models?.[0]?.id)
      if (!model) errors.push(`chunk "${chunk.id}" names model "${chunk?.model}", not in engine "${chunk.engine}"'s list`)
      const key = provider.apiKey || provider.apiKeyRef
      if (!key) warnings.push(`engine "${provider.name}" declares no apiKey/apiKeyRef — the call will be unauthenticated`)
      const messages = Array.isArray(chunk.messages) ? chunk.messages : [{ role: 'user', content: chunk.prompt }]
      const estInput = estimateMessages(messages)
      const window = model?.contextWindow ?? opt.fallbackContextWindow
      const maxInput = Math.floor(window * opt.contextFill)
      const estOutput = Number(chunk.maxTokens) || opt.chunkOutputTokens
      if (estInput + estOutput > window) errors.push(`chunk "${chunk.id}" needs ~${estInput}+${estOutput} tokens but engine "${provider.name}" advertises a ${window} window — re-cut the chunk smaller or move it to a bigger window`)
      else if (estInput > maxInput) warnings.push(`chunk "${chunk.id}" ships ~${estInput} tokens, over ${Math.round(opt.contextFill * 100)}% of "${provider.name}"'s ${window} window — trim the brief (only the files that chunk touches)`)
      for (const file of chunk.writes ?? []) {
        if (writers.has(file)) errors.push(`two chunks write "${file}" (${writers.get(file)} and ${chunk.id}) — disjoint write scopes are required`)
        else writers.set(file, chunk.id)
      }
    }
    return { errors, warnings }
  }

  function rateOf(stamp, kind) {
    if (!stamp) return kind === 'decode' ? opt.fallbackTokPerSec : opt.fallbackPrefillTokPerSec
    if (kind === 'decode') return stamp.decodeTokPerSec ?? stamp.tokPerSec ?? opt.fallbackTokPerSec
    return stamp.prefillTokPerSec ?? (stamp.tokPerSec ?? opt.fallbackTokPerSec) * 0.35
  }

  function estimateSchedule(chunks, sessionId = null) {
    const rows = []
    const index = providersByName()
    const self = selfRoute(sessionId)
    for (const chunk of chunks) {
      const provider = index.get(chunk.engine)
      const model = modelOf(provider, chunk.model ?? provider?.models?.[0]?.id)
      const stamp = benchCache().rows[`${chunk.engine}::${model?.id}`]
      const authority = authorityOfUrl(provider?.baseURL ?? '')
      const shared = Boolean(self?.authority) && authorityMatch(self.authority, authority)
      // Contention is real on the box that also runs this agent. It is priced
      // only when the user sets orchestration.selfContentionPercent.
      const penalty = shared && Number.isFinite(opt.selfContentionPercent) ? Math.min(1, Math.max(0.2, opt.selfContentionPercent / 100)) : 1
      const decode = rateOf(stamp, 'decode') * penalty
      const prefill = rateOf(stamp, 'prefill') * penalty
      const output = Number(chunk.maxTokens) || opt.chunkOutputTokens
      const messages = Array.isArray(chunk.messages) ? chunk.messages : [{ role: 'user', content: chunk.prompt }]
      const input = estimateMessages(messages)
      const ms = Math.round((output / decode) * 1000 + (input / prefill) * 1000)
      rows.push({ id: chunk.id, engine: chunk.engine, model: model?.id ?? chunk.model, host: authority, sharedWithHost: shared, input, output, decodeTokPerSec: round2(decode), prefillTokPerSec: round2(prefill), measured: Boolean(stamp?.tokPerSec), estMs: ms })
    }
    const byEngine = new Map()
    for (const row of rows) byEngine.set(row.engine, [...(byEngine.get(row.engine) ?? []), row])
    const perEngineMs = [...byEngine.entries()].map(([engine, list]) => ({ engine, chunks: list.length, busyMs: list.reduce((sum, r) => sum + r.estMs, 0) }))
    const fleetMs = Math.max(0, ...perEngineMs.map((r) => r.busyMs))
    // Solo baseline = the single *best* box doing all the work, because that is
    // what the human is actually choosing between. Summing the mixed assignment
    // would flatter the split and hide a slow box sitting on the critical path.
    const best = rows.filter((r) => r.measured).sort((a, b) => b.decodeTokPerSec - a.decodeTokPerSec)[0]
    const bestDecode = best?.decodeTokPerSec ?? opt.fallbackTokPerSec
    const bestPrefill = best?.prefillTokPerSec ?? opt.fallbackPrefillTokPerSec
    const soloMs = Math.round(rows.reduce((sum, r) => sum + (r.output / bestDecode) * 1000 + (r.input / bestPrefill) * 1000, 0))
    const unmeasured = rows.filter((r) => !r.measured).map((r) => r.id)
    const sorted = perEngineMs.slice().sort((a, b) => b.busyMs - a.busyMs)
    return {
      chunks: rows,
      perEngine: perEngineMs,
      soloMs,
      fleetMs,
      speedup: fleetMs > 0 ? round2(soloMs / fleetMs) : null,
      recommendSplit: fleetMs > 0 && soloMs / fleetMs >= (opt.minSpeedup ?? 1.4),
      criticalPath: sorted[0]?.engine ?? null,
      idleSlackMs: sorted.length > 1 ? sorted[0].busyMs - sorted[sorted.length - 1].busyMs : 0,
      estimateQuality: unmeasured.length ? `unmeasured: ${unmeasured.join(', ')} (assumed ${opt.fallbackTokPerSec} tok/s — run bench first)` : 'measured',
      unmeasured,
    }
  }

  /* Longest-processing-time packing: the mechanical half of "which box gets
   * which chunk". The agent decides what a chunk means; this only balances load
   * against measured rates, and it never invents an engine.
   *
   * Two objectives, because they disagree:
   *   speed  -> minimum makespan. The packer will happily starve a slow box.
   *   spread -> use every engine the task can fit on, accepting a larger
   *              makespan. This is what "all my computers work" means.
   * Both numbers are returned so the gate can show the cost of utilisation.
   */
  function rebalance(chunks, taskClass, mode = 'spread', sessionId = null) {
    const index = providersByName()
    const self = selfRoute(sessionId)
    const isSelf = (name) => opt.excludeSelfEngine && self?.authority && authorityMatch(self.authority, authorityOfUrl(index.get(name)?.baseURL ?? ''))
    const workOf = (chunk) => {
      const messages = Array.isArray(chunk.messages) ? chunk.messages : [{ role: 'user', content: chunk.prompt }]
      return { input: estimateMessages(messages), output: Number(chunk.maxTokens) || opt.chunkOutputTokens }
    }
    const priced = chunks.map((chunk) => {
      const { input, output } = workOf(chunk)
      const options = [...index.keys()]
        .filter((name) => !isSelf(name))
        .map((name) => {
        const provider = index.get(name)
        const model = provider.models?.[0]
        const stamp = benchCache().rows[`${name}::${model?.id}`]
        return {
          engine: name,
          model: model?.id,
          ms: Math.round((output / rateOf(stamp, 'decode')) * 1000 + (input / rateOf(stamp, 'prefill')) * 1000),
          fits: input + output <= (model?.contextWindow ?? opt.fallbackContextWindow),
          measured: Boolean(stamp?.tokPerSec),
        }
      })
      return { id: chunk.id, role: chunk.role ?? 'worker', work: input + output, options }
    })
    priced.sort((a, b) => b.work - a.work)

    function pack(forceSpread) {
      const load = new Map()
      const assignment = []
      const usableEngines = [...index.keys()].filter((name) => priced.some((item) => item.options.some((option) => option.engine === name && option.fits)))
      for (const item of priced) {
        const usable = item.options.filter((option) => option.fits)
        if (!usable.length) { assignment.push({ id: item.id, engine: null, reason: 'no engine can hold this chunk inside its context window' }); continue }
        const empty = forceSpread ? usableEngines.filter((name) => !load.has(name) && usable.some((option) => option.engine === name)) : []
        const pool = empty.length ? usable.filter((option) => empty.includes(option.engine)) : usable
        pool.sort((a, b) => (a.ms + (load.get(a.engine) ?? 0)) - (b.ms + (load.get(b.engine) ?? 0)))
        const pick = pool[0]
        load.set(pick.engine, (load.get(pick.engine) ?? 0) + pick.ms)
        assignment.push({ id: item.id, role: item.role, engine: pick.engine, model: pick.model, estMs: pick.ms, measured: pick.measured, movedFrom: null })
      }
      return { assignment, makespanMs: Math.max(0, ...[...load.values()]) }
    }

    const spread = pack(true)
    const speed = pack(false)
    const chosen = mode === 'speed' ? speed : spread
    const original = new Map(chunks.map((chunk) => [chunk.id, chunk.engine]))
    for (const row of chosen.assignment) if (row.engine && original.get(row.id) !== row.engine) row.movedFrom = original.get(row.id)
    return {
      ok: true,
      mode,
      taskClass: taskClass ?? null,
      assignment: chosen.assignment,
      makespanMs: chosen.makespanMs,
      moved: chosen.assignment.filter((row) => row.movedFrom).length,
      objectives: {
        spread: { makespanMs: spread.makespanMs, enginesUsed: new Set(spread.assignment.filter((r) => r.engine).map((r) => r.engine)).size },
        speed: { makespanMs: speed.makespanMs, enginesUsed: new Set(speed.assignment.filter((r) => r.engine).map((r) => r.engine)).size },
      },
      tradeoff: spread.makespanMs > speed.makespanMs
        ? `Using every box costs ${Math.round((spread.makespanMs - speed.makespanMs) / 1000)}s more than letting only the fastest box do the work.`
        : 'Every engine is already needed; utilisation costs nothing here.',
      note: 'LPT packing on measured rates. It balances load; it does not know what a chunk means — keep role/semantics the agent chose.',
    }
  }

  /* Bench on demand, once. `autoBench` touches only the engines a plan actually
   * names, and bench() skips every row that still has a fresh measurement, so
   * this is a first-contact cost rather than a ritual before every task. */
  async function ensureMeasured(chunks) {
    if (!opt.autoBench) return { ran: false, engines: [] }
    const index = providersByName()
    const names = [...new Set(chunks.map((chunk) => chunk.engine).filter((name) => index.has(name)))]
    if (!names.length) return { ran: false, engines: [] }
    const result = await bench({ engine: names })
    return { ran: true, engines: names, probed: (result.bench ?? []).filter((row) => !row.cached).length, cached: (result.bench ?? []).filter((row) => row.cached).length }
  }

  async function plan({ chunks, taskClass, balance = true, sessionId = null } = {}) {
    if (!Array.isArray(chunks) || !chunks.length) return { ok: false, error: 'plan needs a chunks array' }
    const measured = await ensureMeasured(chunks)
    const { errors, warnings } = validate(chunks, sessionId)
    const estimate = estimateSchedule(chunks, sessionId)
    const fingerprint = await engines(sessionId)
    return {
      ok: errors.length === 0,
      taskClass: taskClass ?? null,
      errors,
      warnings,
      estimate,
      balance: balance ? rebalance(chunks, taskClass, 'spread', sessionId) : null,
      self: fingerprint.self,
      autoBench: measured,
      needsBench: fingerprint.needsBench,
      engines: fingerprint.engines.filter((row) => row.hasKey),
      gateRule: `Split is offered when speedup ≥ ${opt.minSpeedup ?? 1.4}; below that the honest answer is Solo. Fan-out is dispatched only when this Host itself observed ${opt.keywords.join(' or ')} in a message of the calling session (requireTrigger: false turns that guard off).`,
      askUser: errors.length === 0
        ? (fingerprint.needsBench.length
          ? `These engines have no fresh measurement: ${fingerprint.needsBench.join(', ')}. Bench them once (or let autoBench do it on the next plan), then ask the user Split / Solo.`
          : 'Present this estimate to the user and ask: Split / Solo / Adjust. Only if they answer Split, call run with gate {asked:true, answer:"split"}. The @fleet trigger is checked by this Host, not by you — do not invent it.')
        : 'Fix the errors, then plan again.',
    }
  }

  /* --------------------------------------------------------------------- the run */

  async function run({ chunks, title = 'fleet run', taskClass = null, gate, budget, sessionId } = {}) {
    if (!Array.isArray(chunks) || !chunks.length) return { ok: false, error: 'run needs a chunks array' }
    // Requirement: the split is optional and must pause for the human. Enforced
    // here, in the API, so no agent turn can skip the prompt.
    if (!gate || gate.asked !== true || gate.answer !== 'split') {
      return {
        ok: false,
        error: 'Refusing to dispatch: the fleet split is opt-in. Call plan first, then ask the user (Split / Solo / Adjust), then re-call run with gate: {asked:true, answer:"split", note}.',
        gate: gate ?? null,
      }
    }
    /* Manual control, verified by the Host. The trigger registry is filled by a
     * listener on the session log: this process watched the message that armed
     * it. The agent's `gate.trigger` string is no longer the authority, so a
     * task without @fleet / /fleet cannot be fanned out by a helpful mistake.
     * `orchestration.requireTrigger: false` restores the old behaviour. */
    const live = triggers(sessionId)
    if (opt.requireTrigger !== false && !live.length) {
      return {
        ok: false,
        error: `Refusing to dispatch: this Host never saw ${opt.keywords.join(' or ')} in a message from ${sessionId ? `session ${sessionId}` : 'any session'} within the last ${Math.round(opt.triggerTtlMs / 60000)} minutes. Without that keyword the task runs on one computer; write it in the request if you want the fleet.`,
        keywords: opt.keywords,
        triggerTtlMs: opt.triggerTtlMs,
        requireTrigger: opt.requireTrigger !== false,
      }
    }
    const { errors, warnings } = validate(chunks, sessionId)
    if (errors.length) return { ok: false, error: 'plan did not validate', errors, warnings }
    const measured = await ensureMeasured(chunks)
    const estimate = estimateSchedule(chunks, sessionId)
    const runId = `${now()}-${String(title).toLowerCase().replace(/[^a-z0-9]+/gu, '-').slice(0, 40)}`
    const dir = `${runsDir}/${runId}`
    ensureDir(`${dir}/chunks`)
    const index = providersByName()

    // One queue per engine: a single consumer GPU does not scale with
    // concurrency, so chunks on the same box serialise while boxes overlap.
    const queues = new Map()
    for (const chunk of chunks) queues.set(chunk.engine, [...(queues.get(chunk.engine) ?? []), chunk])

    /* Reasoning-first packs spend most of the budget thinking and return an
     * empty `content` when the cap cuts them off (`finish_reason: length`).
     * That is not a capability failure, it is a budget failure, so the
     * orchestrator escalates the budget once instead of grading a blank. */
    async function chatWithBudget({ provider, model, chunk, messages, budget }) {
      const first = await chat({
        provider,
        model,
        messages,
        maxTokens: chunk.maxTokens ?? opt.chunkOutputTokens,
        temperature: chunk.temperature ?? 0.4,
        json: false, // `response_format` is unproven on these packs; the prompt asks for JSON and grade() parses it.
        effort: chunk.effort,
        timeoutMs: Math.min(chunk.wallClockMs ?? budget?.chunkWallClockMs ?? opt.chunkWallClockMs, budget?.chunkWallClockMs ?? opt.chunkWallClockMs),
      })
      if (!first.starved || chunk.noEscalate) return first
      const escalated = Math.min(
        Math.max(2 * (chunk.maxTokens ?? opt.chunkOutputTokens), 1500),
        Number(model?.maxTokens) || 4096,
        chunk.maxTokensCeiling ?? 4096,
      )
      const second = await chat({
        provider,
        model,
        messages,
        maxTokens: escalated,
        temperature: chunk.temperature ?? 0.4,
        json: false,
        effort: chunk.effort,
        timeoutMs: Math.min(chunk.wallClockMs ?? budget?.chunkWallClockMs ?? opt.chunkWallClockMs, budget?.chunkWallClockMs ?? opt.chunkWallClockMs),
      })
      return { ...second, escalatedFrom: first.maxTokens ?? chunk.maxTokens ?? opt.chunkOutputTokens, firstElapsedMs: first.elapsedMs, attempts: 2 }
    }

    const started = now()
    const record = { runId, title, taskClass, dir, startedAt: started, gate, trigger: live[0] ?? null, autoBench: measured, warnings, estimate, engineConcurrency: opt.perEngineConcurrency, chunks: [] }
    save(`${dir}/run.json`, record)

    const perEngine = await Promise.all(
      [...queues.entries()].map(async ([engineName, list]) => {
        const provider = index.get(engineName)
        const out = []
        for (const chunk of list) {
          const model = modelOf(provider, chunk.model ?? provider?.models?.[0]?.id)
          const messages = Array.isArray(chunk.messages) ? chunk.messages : [{ role: 'user', content: chunk.prompt }]
          const outcome = await chatWithBudget({ provider, model, chunk, messages, budget })
          let verdict = outcome.ok ? grade(outcome.text, chunk.expects) : { graded: false }
          if (outcome.starved) verdict = { graded: true, pass: false, why: `thinking consumed the token budget (${outcome.reasoningTokens ?? '?'} reasoning tokens, finish=length, content empty) — raise maxTokens for this engine` }
          const row = {
            id: chunk.id,
            role: chunk.role ?? 'worker',
            title: chunk.title ?? '',
            engine: engineName,
            host: authorityOfUrl(provider.baseURL),
            model: model?.id ?? chunk.model ?? null,
            status: outcome.ok ? 'done' : 'failed',
            error: outcome.ok ? null : outcome.error,
            timedOut: Boolean(outcome.aborted),
            finish: outcome.finish ?? null,
            starved: Boolean(outcome.starved),
            attempts: outcome.attempts ?? 1,
            escalatedFrom: outcome.escalatedFrom ?? null,
            reasoningTokens: outcome.reasoningTokens ?? 0,
            wallClockMs: outcome.elapsedMs ?? null,
            inputTokens: outcome.promptTokens ?? estimateMessages(messages),
            inputEstimateOnly: outcome.promptTokens == null,
            outputTokens: outcome.completionTokens ?? null,
            tokPerSec: outcome.tokPerSec ?? null,
            verdict,
            writes: chunk.writes ?? [],
            preview: String((outcome.ok ? (outcome.text || outcome.reasoning || '') : (outcome.error ?? '')) ?? '').replace(/\s+/gu, ' ').slice(0, 240),
            artifact: `${dir}/chunks/${chunk.id}.json`,
          }
          save(`${dir}/chunks/${chunk.id}.json`, { ...row, text: outcome.ok ? outcome.text : null, raw: outcome.ok ? null : outcome.error })
          record.chunks.push(row)
          save(`${dir}/run.json`, record)
          out.push(row)
        }
        return out
      }),
    )

    const finished = now()
    const all = perEngine.flat()
    record.finishedAt = finished
    record.wallClockMs = finished - started
    record.summary = summarise(all, estimate, finished - started)
    save(`${dir}/run.json`, record)
    const markdown = summaryMarkdown(record)
    writeFileSync(`${dir}/SUMMARY.md`, markdown)

    // Measured numbers feed the next estimate: the estimator calibrates itself.
    const cache = benchCache()
    for (const row of all) {
      if (!row.tokPerSec) continue
      const key = `${row.engine}::${row.model}`
      cache.rows[key] = { ...(cache.rows[key] ?? {}), engine: row.engine, model: row.model, at: finished, tokPerSec: row.tokPerSec, runTokens: (cache.rows[key]?.runTokens ?? 0) + (row.outputTokens ?? 0) }
    }
    cache.calibration = { estimatedFleetMs: estimate.fleetMs, actualWallClockMs: finished - started, at: finished }
    save(cachePath, cache)

    return { ok: true, runId, dir, wallClockMs: finished - started, estimate: { ...estimate, actualWallClockMs: finished - started }, summary: record.summary, markdown, warnings }
  }

  function summarise(all, estimate, wallClockMs) {
    const byEngine = new Map()
    for (const row of all) {
      const bucket = byEngine.get(row.engine) ?? { engine: row.engine, host: row.host, model: row.model, chunks: [], done: 0, failed: 0, outputTokens: 0, busyMs: 0, verdicts: 0, graded: 0 }
      bucket.chunks.push({ id: row.id, role: row.role, title: row.title, status: row.status, tokPerSec: row.tokPerSec, outputTokens: row.outputTokens, wallClockMs: row.wallClockMs, verdict: row.verdict.graded ? (row.verdict.pass ? 'pass' : `FAIL (${row.verdict.why})`) : 'ungraded', writes: row.writes, artifact: row.artifact, preview: row.preview })
      bucket.done += row.status === 'done' ? 1 : 0
      bucket.failed += row.status === 'failed' ? 1 : 0
      bucket.outputTokens += row.outputTokens ?? 0
      bucket.busyMs += row.wallClockMs ?? 0
      if (row.verdict.graded) {
        bucket.graded += 1
        if (row.verdict.pass) bucket.verdicts += 1
      }
      byEngine.set(row.engine, bucket)
    }
    const perEngine = [...byEngine.values()].sort((a, b) => b.busyMs - a.busyMs)
    const idle = perEngine.length > 1 ? Math.round(perEngine[0].busyMs - Math.min(...perEngine.map((e) => e.busyMs))) : 0
    return {
      wallClockMs,
      perEngine,
      totals: {
        chunks: all.length,
        done: all.filter((r) => r.status === 'done').length,
        failed: all.filter((r) => r.status === 'failed').length,
        graded: all.filter((r) => r.verdict.graded).length,
        gradedPass: all.filter((r) => r.verdict.graded && r.verdict.pass).length,
        outputTokens: all.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
        estimatedFleetMs: estimate.fleetMs,
        estimatedSoloMs: estimate.soloMs,
        estimatedSpeedup: estimate.speedup,
        busiestMinusQuietestMs: idle,
      },
    }
  }

  function summaryMarkdown(record) {
    const s = record.summary
    const mins = (ms) => `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)}s`
    const lines = [
      `# Fleet run ${record.runId}`,
      `Task: ${record.title}${record.taskClass ? ` · class: ${record.taskClass}` : ''}`,
      `Wall clock ${mins(s.wallClockMs)} · estimated fleet ${mins(record.estimate?.fleetMs)} vs solo ${mins(record.estimate?.soloMs)} (×${record.estimate?.speedup ?? '?'}) · gate: ${record.gate?.answer}${record.gate?.note ? ` (${record.gate.note})` : ''} · armed by ${record.trigger?.keyword ?? 'no keyword'}`,
      '',
      '## What each computer did',
      '',
      '| engine | host | model | chunks | done/failed | busy | tok/s | graded pass | tokens out |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ]
    for (const e of s.perEngine) {
      const tps = e.chunks.map((c) => c.tokPerSec).filter((v) => v).map((v) => v.toFixed?.(1) ?? v)
      lines.push(`| ${e.engine} | ${e.host} | ${e.model} | ${e.chunks.map((c) => `${c.id}${c.role ? ` (${c.role})` : ''}`).join(', ')} | ${e.done}/${e.failed} | ${mins(e.busyMs)} | ${tps.join(', ') || '-'} | ${e.verdicts}/${e.graded} | ${e.outputTokens} |`)
    }
    lines.push('')
    lines.push('## Per chunk')
    lines.push('')
    for (const e of s.perEngine) {
      for (const c of e.chunks) {
        lines.push(`- **${c.id}** · ${e.engine} (${e.host}) · ${c.role} · ${c.status} · ${c.wallClockMs ?? '?'}ms · ${c.outputTokens ?? '?'} out tokens${c.writes?.length ? ` · writes: ${c.writes.join(', ')}` : ''}`)
        if (c.title) lines.push(`  - assigned: ${c.title}`)
        lines.push(`  - check: ${c.verdict}`)
        if (c.preview) lines.push(`  - said: ${c.preview.slice(0, 200)}`)
        lines.push(`  - artifact: ${c.artifact}`)
      }
    }
    if (record.warnings?.length) {
      lines.push('')
      lines.push('## Warnings')
      for (const w of record.warnings) lines.push(`- ${w}`)
    }
    lines.push('')
    lines.push(`Merged here by this Host: chunks return artifacts only — no other machine ever touched this working tree.`)
    return lines.join('\n')
  }

  async function runs() {
    if (!existsSync(runsDir)) return { ok: true, runs: [] }
    const rows = []
    const names = readdirSync(runsDir)
    for (const name of names) {
      const record = load(`${runsDir}/${name}/run.json`, null)
      if (record) rows.push({ runId: record.runId, title: record.title, taskClass: record.taskClass, startedAt: record.startedAt, wallClockMs: record.wallClockMs, engines: [...new Set((record.chunks ?? []).map((c) => c.engine))], chunks: (record.chunks ?? []).length, done: (record.chunks ?? []).filter((c) => c.status === 'done').length, dir: record.dir })
    }
    rows.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    return { ok: true, runs: rows.slice(0, 30) }
  }

  async function runView({ id } = {}) {
    if (!id) return { ok: false, error: 'run view needs an id' }
    const record = load(`${runsDir}/${id}/run.json`, null)
    if (!record) return { ok: false, error: `no run "${id}"` }
    return { ok: true, run: record, markdown: summaryMarkdown(record) }
  }

  return { engines, bench, plan, run, runs, runView, estimateSchedule, rebalance, validate, grade, hostRoute, selfRoute, PROBE_ITEMS }
}

/* ------------------------------------------------------------------- helpers */

function authorityOfUrl(value) {
  try {
    return new URL(String(value)).host
  } catch {
    return String(value ?? '')
  }
}

function authorityMatch(a, b) {
  const norm = (value) => {
    const [host, port] = String(value ?? '').split(':')
    const hostNorm = host === 'localhost' ? '127.0.0.1' : host
    return `${hostNorm}:${port ?? ''}`
  }
  return norm(a) === norm(b)
}

function isLocalAuthority(authority) {
  return /^(127\.0\.0\.1|localhost|::1|\[::1\])(:\d+)?$/u.test(String(authority))
}

function ageHours(stamps, now) {
  const newest = Math.max(0, ...stamps.filter((v) => Number.isFinite(v)))
  if (!newest) return null
  return round2((now - newest) / 3600000)
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100
}
