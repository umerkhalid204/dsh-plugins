/**
 * dsh-plugin-fleet — Host half.
 *
 * One place to define, launch, and switch between several concurrent DSH hosts,
 * each with its own `DSH_HOME`, its own port, and a different default LLM
 * provider, so one machine can drive several LLM boxes at once.
 *
 * Verified against the installed Harness (0.2.2-rc.1):
 *
 * - The Desktop app is hard single-instance (`app.requestSingleInstanceLock()`),
 *   so extra hosts must be separate processes. `dsh --profile <name> web`
 *   supports `--no-open --port <n>` and prints one readiness line
 *   `dsh web: http://127.0.0.1:<port>/?token=…` that mints a signed cookie
 *   (303 → `/`), which is exactly what this plugin captures and hands to the UI.
 * - `dsh --profile <name> --from-default-profile web` creates a custom profile
 *   from the shipped web template; it is passed only when the profile does not
 *   exist yet, so a re-provision never destroys settings the child saved itself.
 * - Provider routes are added to a child by an overlay patch
 *   (`dsh --patch <file>`, applied after the profile layer) that restates
 *   `llm-pi-ai`'s whole `config.providers` map plus `agent-default-model`.
 *   DeepSeek itself comes from its own adapter rows in `dsh-base`, so overriding
 *   this row never removes it — every child sees every provider and opens on a
 *   different default model.
 * - Children are `detached` and tracked by a state file, because the ordinary
 *   Config path restarts a plugin; `providers` and `instances` are declared
 *   volatile so a save updates them in place without a remount and without any
 *   risk of tearing down the hosts they manage.
 * - Secrets never enter YAML: a provider key is written into the child's
 *   `.env` and referenced from the patch as `apiKeyEnv`.
 *
 * One `operations` object serves both the Web routes and the `fleet` tool, so
 * the page and the agent cannot drift apart.
 */
import { spawn } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Harness packages are imported when the realm exposes them and stood in for
 * when it does not, so a linked checkout still activates.
 */
const homePaths = await import('@deepseek-ai/dsh-home-paths').catch(() => null)
const appBoot = await import('@deepseek-ai/dsh-app-boot').catch(() => null)
const schemastery = (await import('@deepseek-ai/schemastery').catch(() => null))?.default ?? null

const PI_AI_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages']
const PROBE_VENDORS = ['openai', 'ollama', 'lmstudio', 'strata', 'lemonade', 'openai-completions', 'openai-responses', 'anthropic-messages']
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const DEFAULT_PORT_BASE = 3101
const LOG_TAIL_BYTES = 24_000
const MAX_STATE_LINES = 400
const MAX_BODY_BYTES = 1 << 17
const URL_LINE = /^dsh web:\s+(\S+)/gm

/** Volatile config fields arrive as reactive cells; unwrap a live value. */
function unwrap(value) {
  return value && typeof value.get === 'function' && typeof value.set === 'function' ? value.get() : value
}

function parentHome() {
  try {
    const home = homePaths?.resolveDshHome?.()
    if (typeof home === 'string' && home) return home
  } catch {}
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * The runtime version this Host runs. Three sources, best first:
 * 1. an in-box package's own manifest, resolved through this module's realm —
 *    works whenever the bundle sits inside the profile tree (a git/registry
 *    install), because the profile's flat `node_modules` fallback reaches the
 *    installation;
 * 2. the packaged Desktop app's bundled runtime manifest, reachable through
 *    Electron's asar-aware fs;
 * 3. the Desktop shell's own manifest version, which ships equal to the
 *    bundled dsh version.
 * A `link:` install from outside the profile tree cannot do (1) — that is a
 * development layout, not the shipped one, and the fallbacks cover it.
 */
let hostVersionCache
function hostVersion() {
  if (hostVersionCache !== undefined) return hostVersionCache || undefined
  for (const pkg of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-agent']) {
    try {
      let dir = dirname(fileURLToPath(import.meta.resolve(pkg)))
      for (let depth = 0; depth < 6 && dir.length > 1; depth += 1) {
        try {
          const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
          if (manifest.name === pkg && typeof manifest.version === 'string' && manifest.version) {
            hostVersionCache = manifest.version
            return manifest.version
          }
        } catch {}
        dir = dirname(dir)
      }
    } catch {}
  }
  const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined
  if (resources !== undefined) {
    for (const candidate of [join(resources, 'app.asar', 'dsh', 'package.json'), join(resources, 'app.asar', 'package.json')]) {
      try {
        const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
        if (typeof manifest.version === 'string' && manifest.version) {
          hostVersionCache = manifest.version
          return manifest.version
        }
      } catch {}
    }
  }
  try {
    hostVersionCache = appBoot?.getDshRuntimeVersion?.() ?? ''
  } catch {
    hostVersionCache = ''
  }
  return hostVersionCache || undefined
}

/** `~` and `$HOME` expansion, absolute normalization. */
function expandPath(input, fallback = undefined) {
  if (typeof input !== 'string' || !input.trim()) return fallback
  const value = input.trim()
  const home = homedir()
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
  return isAbsolute(value) ? value : resolvePath(value)
}

function slug(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function envKeyFor(name) {
  return `FLEET_${slug(name).replace(/-/g, '_').toUpperCase()}_KEY`
}

/* ------------------------------------------------------------------ config */

function mark(node, meta) {
  if (node?.meta) Object.assign(node.meta, meta)
  return node
}

function buildConfig(S) {
  if (typeof S?.object !== 'function' || typeof S?.dict !== 'function' || typeof S?.array !== 'function' || typeof S?.union !== 'function') {
    return undefined
  }
  const model = S.object({
    id: S.string(),
    name: S.string(),
    contextWindow: S.natural(),
    maxTokens: S.natural(),
    input: S.array(S.string()),
    reasoningEfforts: S.union([S.const(false), S.dict(S.string())]),
  })
  const provider = S.object({
    name: S.string(),
    label: S.string(),
    api: S.union(PI_AI_APIS.map((value) => S.const(value))),
    baseURL: S.string(),
    // Write-only: surfaces see that a key exists, never the value.
    apiKey: mark(S.string(), { role: 'secret' }),
    apiKeyRef: S.string(),
    note: S.string(),
    models: S.array(model),
  })
  const instance = S.object({
    id: S.string(),
    label: S.string(),
    port: S.natural(),
    home: S.string(),
    providers: S.array(S.string()),
    bundles: S.array(S.string()),
    seedEnv: S.boolean(),
    autostart: S.boolean(),
    default: S.object({
      provider: S.string(),
      model: S.string(),
      reasoningEffort: S.union(EFFORTS.map((value) => S.const(value))),
    }),
  })
  const providers = S.array(provider)
  const instances = S.array(instance)
  // Volatile: a save updates the registry in place instead of remounting the
  // row, so the Hosts this plugin owns are never torn down by an edit.
  providers.meta.volatile = true
  instances.meta.volatile = true
  return S.object({
    root: S.string(),
    homeRoot: S.string(),
    launcher: S.string(),
    portBase: S.natural(),
    requireVersion: S.boolean(),
    requireSameOrigin: S.union([S.boolean(), S.const('observe')]),
    openMode: S.union([S.const('tab'), S.const('browser'), S.const('chrome-app'), S.const('none')]),
    autostartOnBoot: S.boolean(),
    startTimeoutMs: S.natural(),
    probeTimeoutMs: S.natural(),
    providers,
    instances,
  })
}

export const Config = schemastery ? buildConfig(schemastery) : undefined

/* --------------------------------------------------------------- yaml writer */

/**
 * Minimal block-style YAML emitter. Every scalar is written with JSON quoting,
 * which is valid YAML, so endpoints, model ids and names never need a second
 * escaping pass. No anchors, no flow maps — a generated file stays readable.
 */
function yaml(value, indent = 0) {
  const pad = '  '.repeat(indent)
  if (Array.isArray(value)) {
    if (!value.length) return ' []'
    let out = ''
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        const body = yaml(item, indent + 1).trimStart()
        out += `\n${pad}- ${body.replace(/^\s+/gu, '')}`
      } else {
        out += `\n${pad}- ${scalar(item)}`
      }
    }
    return out
  }
  if (value !== null && typeof value === 'object') {
    let out = ''
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      if (item !== null && typeof item === 'object') {
        if (Array.isArray(item) && !item.length) {
          out += `\n${pad}${key}: []`
          continue
        }
        if (!Array.isArray(item) && !Object.keys(item).length) {
          out += `\n${pad}${key}: {}`
          continue
        }
        out += `\n${pad}${key}:${yaml(item, indent + 1)}`
      } else {
        out += `\n${pad}${key}: ${scalar(item)}`
      }
    }
    return out
  }
  return ` ${scalar(value)}`
}

function scalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(String(value))
}

function emitDocument(rows, header) {
  let out = `${header}\n`
  for (const row of rows) {
    out += `\n- ${yaml(row, 1).trimStart()}\n`
  }
  return out
}

/* ------------------------------------------------------------ file helpers */

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

function tailText(path, bytes = LOG_TAIL_BYTES) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return ''
  }
  if (!stat.size) return ''
  const start = Math.max(0, stat.size - bytes)
  let handle
  try {
    handle = openSync(path, 'r')
    const buffer = Buffer.alloc(stat.size - start)
    readSync(handle, buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle)
      } catch {}
    }
  }
}

function pidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/* ------------------------------------------------------------ small helpers */

function parseBody(raw) {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return null
  }
}

/** Registry-independent defaults, applied on read so a saved row stays short. */
function normalizeInstance(row, index, paths) {
  const id = slug(row?.id ?? row?.label)
  const providers = Array.isArray(row?.providers) ? row.providers.filter((p) => typeof p === 'string' && p) : ['*']
  return {
    id,
    label: typeof row?.label === 'string' && row.label.trim() ? row.label.trim() : id,
    port: Number.isInteger(row?.port) && row.port > 1024 && row.port < 65536 ? row.port : paths.portBase + index,
    home: expandPath(row?.home) ?? join(paths.homeRoot, id),
    providers: providers.length ? providers : ['*'],
    bundles: Array.isArray(row?.bundles) ? row.bundles.filter((b) => typeof b === 'string' && b) : [],
    seedEnv: row?.seedEnv !== false,
    autostart: row?.autostart === true,
    default:
      row?.default && typeof row.default === 'object'
        ? {
            provider: typeof row.default.provider === 'string' ? row.default.provider : '',
            model: typeof row.default.model === 'string' ? row.default.model : '',
            ...(EFFORTS.includes(row.default.reasoningEffort) ? { reasoningEffort: row.default.reasoningEffort } : {}),
          }
        : { provider: '', model: '' },
  }
}

function normalizeProvider(row) {
  const name = slug(row?.name)
  if (!name) return null
  const api = PI_AI_APIS.includes(row?.api) ? row.api : 'openai-completions'
  const models = (Array.isArray(row?.models) ? row.models : [])
    .filter((model) => model && typeof model.id === 'string' && model.id.trim())
    .map((model) => ({
      id: model.id.trim(),
      ...(typeof model.name === 'string' && model.name.trim() ? { name: model.name.trim() } : {}),
      ...(Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
      ...(Number.isInteger(model.maxTokens) && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
      ...(Array.isArray(model.input) && model.input.length ? { input: model.input.filter((v) => v === 'text' || v === 'image') } : {}),
      // Levels a pack actually accepts, or `false` for none. Without this the
      // round-trip would silently drop a hand-declared capability map.
      ...(model.reasoningEfforts === false
        ? { reasoningEfforts: false }
        : model.reasoningEfforts && typeof model.reasoningEfforts === 'object'
          ? { reasoningEfforts: Object.fromEntries(Object.entries(model.reasoningEfforts).filter(([, value]) => typeof value === 'string')) }
          : {}),
      ...(model.compat && typeof model.compat === 'object' ? { compat: model.compat } : {}),
    }))
  return {
    name,
    label: typeof row?.label === 'string' && row.label.trim() ? row.label.trim() : name,
    api,
    baseURL: String(row?.baseURL ?? '').trim(),
    ...(typeof row?.apiKey === 'string' && row.apiKey.trim() ? { apiKey: row.apiKey.trim() } : {}),
    ...(typeof row?.apiKeyRef === 'string' && row.apiKeyRef.trim() ? { apiKeyRef: row.apiKeyRef.trim() } : {}),
    ...(typeof row?.note === 'string' && row.note.trim() ? { note: row.note.trim() } : {}),
    models,
  }
}

function registryHash(instance, providers) {
  const relevant = providers
    .filter((p) => instance.providers.includes('*') || instance.providers.includes(p.name))
    .map((p) => ({
      name: p.name,
      api: p.api,
      baseURL: p.baseURL,
      key: p.apiKey ? 'literal' : p.apiKeyRef ?? '',
      models: p.models.map((m) => [m.id, m.contextWindow ?? 0, m.maxTokens ?? 0]),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const shape = { instance, providers: relevant }
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16)
}

/** Read the model ids of one provider's `.env` reference set. */
function envValues(path) {
  const out = new Map()
  for (const line of readText(path).split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    out.set(match[1], match[2].trim().replace(/^["']|["']$/g, ''))
  }
  return out
}

/** Pull the useful line out of a dsh startup diagnostic without echoing secrets. */
function startupSummary(output) {
  const text = String(output ?? '')
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const errors = lines.filter((line) => /(^|\s)(Error|error):/u.test(line) || /did not activate|refused|invalid|denied|unsupported/iu.test(line))
  const picked = (errors.length ? errors : lines.slice(-6)).slice(0, 6)
  const summary = picked.join(' | ') || text.slice(-400)
  return summary.slice(0, 700)
}

/** Pull `host:port` out of an origin, referer, or Host header for comparison. */
function authorityOf(value) {
  const raw = String(value ?? '').trim().replace(/\/+$/u, '')
  if (!raw) return undefined
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`)
    const host = url.hostname.replace(/^\[(.*)\]$/u, '$1').toLowerCase()
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    return { host, port }
  } catch {
    return undefined
  }
}

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

/**
 * A browser treats `localhost` and `127.0.0.1` as different origins, which would
 * otherwise reject a legitimate page on one alias of the same loopback listener.
 * Aliases are equated only when both sides are loopback, and a port always has
 * to match.
 */
function authorityMatch(a, b) {
  const left = authorityOf(a)
  const right = authorityOf(b)
  if (!left || !right) return false
  if (left.port !== right.port) return false
  if (left.host === right.host) return true
  return isLoopback(left.host) && isLoopback(right.host)
}

/* =================================================================== plugin */

export const name = 'fleet'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const paths = {
    root: expandPath(unwrap(config.root)) ?? join(parentHome(), 'fleet'),
    homeRoot: expandPath(unwrap(config.homeRoot)) ?? join(homedir(), '.dsh-fleet'),
    portBase: Number.isInteger(unwrap(config.portBase)) ? unwrap(config.portBase) : DEFAULT_PORT_BASE,
  }
  const settings = {
    launcher: String(unwrap(config.launcher) ?? 'auto'),
    requireVersion: unwrap(config.requireVersion) !== false,
    openMode: ['tab', 'browser', 'chrome-app', 'none'].includes(unwrap(config.openMode)) ? unwrap(config.openMode) : 'tab',
    autostartOnBoot: unwrap(config.autostartOnBoot) !== false,
    requireSameOrigin: (() => {
      const value = unwrap(config.requireSameOrigin)
      if (value === false || value === 'observe') return value
      return true
    })(),
    startTimeoutMs: Number.isInteger(unwrap(config.startTimeoutMs)) ? unwrap(config.startTimeoutMs) : 90_000,
    probeTimeoutMs: Number.isInteger(unwrap(config.probeTimeoutMs)) ? unwrap(config.probeTimeoutMs) : 5_000,
  }
  const statePath = (id) => join(paths.root, 'state', `${id}.json`)
  const logPath = (id) => join(paths.root, 'logs', `${id}.log`)
  const patchPath = (id) => join(paths.root, 'patches', `${id}.llm.yml`)

  let launcherCache = { at: 0, value: null }
  const starting = new Set()
  const guardRejections = []

  /* ---------- registry ---------- */

  function registry() {
    const providers = (unwrap(config.providers) ?? []).map(normalizeProvider).filter(Boolean)
    const instances = (unwrap(config.instances) ?? []).map((row, index) => normalizeInstance(row, index, paths)).filter((row) => row.id)
    return { providers, instances }
  }

  /** Persist through the Harness config editor, never by rewriting the patch by hand. */
  async function persist(next) {
    const entry = ctx.fiber?.entry
    const editor = ctx.get?.('configEditor')
    if (entry === undefined || editor === undefined) {
      throw new Error('This profile has no config editor, so the fleet registry cannot be saved here (it is read-only without a profile).')
    }
    await editor.edit(entry, (current) => ({
      ...(current && typeof current === 'object' ? current : {}),
      providers: next.providers,
      instances: next.instances,
    }))
    return next
  }

  /* ---------- launcher resolution ---------- */

  function candidateBins() {
    const out = []
    if (settings.launcher && settings.launcher !== 'auto') out.push(expandPath(settings.launcher))
    out.push(join(paths.root, 'cli', 'node_modules', '.bin', 'dsh'))
    out.push(join(parentHome(), 'fleet', 'cli', 'node_modules', '.bin', 'dsh'))
    for (const dir of String(process.env.PATH ?? '').split(delimiter())) {
      if (dir) out.push(join(dir, 'dsh'))
    }
    out.push('/opt/homebrew/bin/dsh', '/usr/local/bin/dsh')
    return out.filter(Boolean)
  }

  function delimiter() {
    return process.platform === 'win32' ? ';' : ':'
  }

  function versionOf(bin) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch {
        return resolve(undefined)
      }
      let out = ''
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
        resolve(undefined)
      }, 15_000)
      child.stdout.on('data', (chunk) => {
        out += String(chunk)
      })
      child.on('error', () => {
        clearTimeout(timer)
        resolve(undefined)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const version = /(\d+\.\d+\.\d+[^\s]*)/.exec(out.trim())?.[1]
        resolve(code === 0 && version ? version : undefined)
      })
    })
  }

  async function launcher(force = false) {
    if (!force && launcherCache.value && Date.now() - launcherCache.at < 60_000) return launcherCache.value
    const wanted = hostVersion()
    const tried = []
    let first = null
    let exact = null
    for (const bin of candidateBins()) {
      if (!existsSync(bin)) continue
      const version = await versionOf(bin)
      tried.push(`${bin} (${version ?? 'unreadable'})`)
      if (!version) continue
      if (!first) first = { bin, version }
      if (wanted && version === wanted) {
        exact = { bin, version }
        break
      }
    }
    const found = exact ?? first
    const value = found
      ? {
          path: found.bin,
          version: found.version,
          wanted,
          ok: !wanted || found.version === wanted,
          ...(exact ? {} : wanted && found.version !== wanted
            ? {
                reason: `The launcher reports ${found.version} but this Harness runs ${wanted}. Plugins are admitted by exact version, and older launchers do not even know \`--from-default-profile\`, so an instance started with it can fail to boot.`,
                installHint: `npm install --prefix "${join(paths.root, 'cli')}" @deepseek-ai/dsh@${wanted}`,
              }
            : {}),
          ...(wanted && !exact && first ? { fallback: true } : {}),
          tried,
        }
      : {
          path: null,
          version: null,
          wanted,
          ok: false,
          reason: `No usable \`dsh\` launcher was found (checked: ${tried.length ? tried.join(', ') : 'nothing on PATH'}). Install the version this Harness runs on.`,
          installHint: `npm install --prefix "${join(paths.root, 'cli')}" @deepseek-ai/dsh@${wanted ?? 'latest'}`,
          tried,
        }
    launcherCache = { at: Date.now(), value }
    return value
  }

  /** Run the launcher for a provisioning step (profile creation), capturing its output. */
  async function runLauncher({ bin, args, home, timeoutMs = 120_000 }) {
    const plan = launchPlan(bin)
    return new Promise((resolve) => {
      const chunks = []
      let child
      try {
        child = spawn(plan.command, [...plan.prefix, ...args], { cwd: home, env: childEnv(home, plan.env), stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        return resolve({ ok: false, exit: null, output: String(error?.message ?? error) })
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
      }, timeoutMs)
      child.stdout.on('data', (chunk) => chunks.push(String(chunk)))
      child.stderr.on('data', (chunk) => chunks.push(String(chunk)))
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ ok: false, exit: null, output: String(error?.message ?? error) })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ ok: code === 0, exit: code, output: chunks.join('').slice(-8000) })
      })
    })
  }

  function childEnv(home, extra = {}) {
    const env = { ...process.env, ...extra }
    for (const key of ['DSH_SESSION_ID', 'DSH_SHELL', 'DSH_WEB_URL', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_DIR', 'DSH_SNAPSHOT']) delete env[key]
    env.DSH_HOME = home
    return env
  }

  /**
   * How to run the `dsh` launcher from *this* process. A Desktop Host is an
   * Electron binary, so `process.execPath` is only usable as a plain Node when
   * `ELECTRON_RUN_AS_NODE` is set; a launcher that is a shebang script instead
   * runs through the `node` on PATH. Resolving the symlink tells us which case
   * we are in, and the generated argument list is identical either way.
   */
  function launchPlan(bin) {
    if (!bin) return { command: 'dsh', prefix: [], env: {} }
    let target = bin
    try {
      target = realpathSync(bin)
    } catch {}
    if (/\.(js|mjs|cjs)$/u.test(target)) {
      return {
        command: process.execPath,
        prefix: [target],
        env: process.versions?.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
      }
    }
    return { command: target, prefix: [], env: {} }
  }

  /* ---------- provisioning ---------- */

  function seedEnvironment(home, needed) {
    const notes = []
    const parentEnv = join(parentHome(), '.env')
    const targetEnv = join(home, '.env')
    if (!existsSync(targetEnv) && existsSync(parentEnv)) {
      try {
        mkdirSync(home, { recursive: true })
        writeFileSync(targetEnv, readFileSync(parentEnv))
        // `credentials-local` refuses a credential file readable beyond its owner.
        chmodOwnerOnly(targetEnv)
        notes.push('copied the parent `.env` so credentials resolve in this home too')
      } catch (error) {
        notes.push(`could not copy \`.env\`: ${error?.message ?? error}`)
      }
    }
    const parentCredentials = join(parentHome(), '.credentials.yaml')
    if (!existsSync(join(home, '.credentials.yaml')) && existsSync(parentCredentials)) {
      try {
        const credentials = join(home, '.credentials.yaml')
        writeFileSync(credentials, readFileSync(parentCredentials))
        chmodOwnerOnly(credentials)
        notes.push('copied the parent credential store (mode 600)')
      } catch (error) {
        notes.push(`could not copy credentials: ${error?.message ?? error}`)
      }
    }
    if (needed.size) {
      const existing = envValues(targetEnv)
      let added = 0
      let text = readText(targetEnv)
      for (const [key, value] of needed) {
        if (existing.has(key) || !value) continue
        text += `${text && !text.endsWith('\n') ? '\n' : ''}${key}=${value}\n`
        added += 1
      }
      if (added) {
        mkdirSync(dirname(targetEnv), { recursive: true })
        writeFileSync(targetEnv, text)
        chmodOwnerOnly(targetEnv)
        notes.push(`wrote ${added} provider key(s) into \`${basename(targetEnv)}\` (never into the patch)`)
      }
    }
    return notes
  }

  function chmodOwnerOnly(path) {
    try {
      chmodSync(path, 0o600)
    } catch {}
  }

  function buildPatch(instance, providers) {
    const chosen = providers.filter((p) => instance.providers.includes('*') || instance.providers.includes(p.name))
    const routes = {}
    const keyRefs = new Map()
    const skipped = []
    for (const provider of chosen) {
      // pi-ai refuses a hand-declared route that cannot name a model, and a
      // refused provider row takes the whole row down with it — so an empty
      // catalog stays out of the child until an endpoint test fills it.
      if (!provider.models.length) {
        skipped.push(`${provider.name} (no models: test the endpoint or add a model line)`)
        continue
      }
      const ref = provider.apiKeyRef || (provider.apiKey ? envKeyFor(provider.name) : undefined)
      if (provider.apiKey) keyRefs.set(ref, provider.apiKey)
      routes[provider.name] = {
        api: provider.api,
        baseURL: provider.baseURL,
        displayName: provider.label,
        ...(ref ? { apiKeyEnv: ref } : {}),
        models: provider.models,
      }
    }
    const rows = []
    if (Object.keys(routes).length) {
      rows.push({ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: routes } })
    }
    if (instance.default?.provider && instance.default?.model) {
      rows.push({
        id: 'agent-default-model',
        name: '@deepseek-ai/dsh-agent-default-model',
        config: {
          provider: instance.default.provider,
          model: instance.default.model,
          ...(instance.default.reasoningEffort ? { reasoningEffort: instance.default.reasoningEffort } : {}),
        },
      })
    }
    return {
      text: emitDocument(rows, `# Generated by dsh-plugin-fleet for instance "${instance.id}" — do not edit by hand.\n# Providers live in the Fleet page (or the \`fleet\` tool); re-provisioning rewrites this file.`),
      keyRefs,
      skipped,
      providerCount: Object.keys(routes).length,
    }
  }

  function profileDir(home, id) {
    return join(home, 'profiles', id)
  }

  async function provision(id, { forceProfile = false } = {}) {
    const { providers, instances } = registry()
    const instance = instances.find((row) => row.id === id)
    if (!instance) return { ok: false, error: `No fleet instance "${id}" in the registry.` }
    const warnings = []
    const home = instance.home
    mkdirSync(join(home, 'profiles'), { recursive: true })
    const dir = profileDir(home, instance.id)
    const manifest = readJson(join(dir, 'package.json'))
    const needsProfile = forceProfile || !manifest
    const bin = await launcher()
    if (!bin.path) {
      return { ok: false, error: `${bin.reason} (${bin.tried?.filter(Boolean).join(', ') || 'nothing found'})`, instance: await snapshot(instance, providers) }
    }
    if (!bin.ok) warnings.push(bin.reason)
    if (needsProfile) {
      const result = await runLauncher({
        bin: bin.path,
        args: ['--profile', instance.id, '--from-default-profile', 'web', '--dump-config'],
        home,
      })
      if (!result.ok) {
        return {
          ok: false,
          error: `Could not create the profile "${instance.id}" in ${home}: ${result.output.slice(-400) || `exit ${result.exit}`}`,
          instance: await snapshot(instance, providers),
        }
      }
      warnings.push(`created profile \`${instance.id}\` from the shipped web template`)
    }
    if (manifest?.dsh?.profile?.bundles && instance.bundles.length) {
      const merged = [...new Set([...manifest.dsh.profile.bundles, ...instance.bundles])]
      if (merged.length !== manifest.dsh.profile.bundles.length) {
        writeJsonAtomic(join(dir, 'package.json'), { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: merged } } })
        warnings.push('added the instance bundles to the profile manifest (run `dsh plugin --profile ' + instance.id + ' install` in that home once)')
      }
    }
    const patch = buildPatch(instance, providers)
    // Resolve each referenced credential *here* and seed the value into the
    // child's own `.env`. A child never sees where this Host found the value
    // (ambient process env, the launching directory's `.env`), and it cannot
    // read this Host's home, so an unresolved reference would surface at the
    // first model request as MISSING_CREDENTIAL.
    for (const provider of providers.filter((p) => instance.providers.includes('*') || instance.providers.includes(p.name))) {
      if (provider.apiKey || !provider.apiKeyRef) continue
      const value = await resolveKey(provider.apiKeyRef)
      if (value) patch.keyRefs.set(provider.apiKeyRef, value)
      else warnings.push(`this Host could not resolve credential reference \`${provider.apiKeyRef}\` — store it in \`${join(home, '.env')}\` or that instance will fail its first request with MISSING_CREDENTIAL`)
    }
    mkdirSync(dirname(patchPath(instance.id)), { recursive: true })
    writeFileSync(patchPath(instance.id), patch.text)
    if (patch.skipped.length) warnings.push(`left out of the child config: ${patch.skipped.join('; ')}`)
    if (instance.seedEnv) warnings.push(...seedEnvironment(home, patch.keyRefs))
    // Prove the child will actually accept this layer before anything is started:
    // a config the profile refuses would otherwise surface as a dead Host.
    const verified = await runLauncher({
      bin: bin.path,
      args: ['--profile', instance.id, '--patch', patchPath(instance.id), '--dump-config'],
      home,
    })
    if (!verified.ok) {
      return {
        ok: false,
        error: `The generated provider layer was refused by profile "${instance.id}": ${startupSummary(verified.output)}`,
        instance: await snapshot(instance, providers),
      }
    }
    const state = readJson(statePath(instance.id)) ?? {}
    writeJsonAtomic(statePath(instance.id), {
      ...state,
      id: instance.id,
      port: instance.port,
      home,
      provisionedAt: Date.now(),
      provisionHash: registryHash(instance, providers),
    })
    return { ok: true, warnings, instance: await snapshot(instance, providers) }
  }

  /* ---------- lifecycle ---------- */

  async function start(id) {
    if (starting.has(id)) return { ok: false, error: `A start for "${id}" is already in progress.` }
    starting.add(id)
    try {
      const { providers, instances } = registry()
      const instance = instances.find((row) => row.id === id)
      if (!instance) return { ok: false, error: `No fleet instance "${id}" in the registry.` }
      const current = await snapshot(instance, providers)
      if (current.status === 'running') return { ok: true, instance: current, warnings: ['Already running; nothing to do.'] }
      const busy = await portAnswered(instance.port)
      if (busy && current.status !== 'running') {
        return {
          ok: false,
          error: `Port ${instance.port} is already answering HTTP but not for this instance. Change the port in the editor or stop whatever holds it.`,
          instance: { ...current, lastError: `port ${instance.port} busy`, portBusy: true },
        }
      }
      const prepared = await provision(id)
      if (!prepared.ok) return prepared
      const bin = await launcher()
      const log = logPath(id)
      mkdirSync(dirname(log), { recursive: true })
      const plan = launchPlan(bin.path)
      const args = ['--profile', id, '--patch', patchPath(id), '--no-open', '--port', String(instance.port)]
      const out = openSync(log, 'a')
      let child
      try {
        child = spawn(plan.command, [...plan.prefix, ...args], { cwd: instance.home, env: childEnv(instance.home, plan.env), detached: true, stdio: ['ignore', out, out] })
      } catch (error) {
        return { ok: false, error: `Could not launch the host: ${error?.message ?? error}` }
      } finally {
        // The child holds its own duplicate of the descriptor.
        try {
          closeSync(out)
        } catch {}
      }
      const pid = child.pid
      if (!pid) {
        return { ok: false, error: 'The launcher process died before it reported a pid.', instance: await snapshot(instance, providers) }
      }
      child.unref()
      child.on('error', (error) => console.warn(`dsh-fleet: host "${id}" pid ${pid} errored: ${error?.message ?? error}`))
      writeJsonAtomic(statePath(id), {
        ...(readJson(statePath(id)) ?? {}),
        id,
        pid,
        port: instance.port,
        home: instance.home,
        startedAt: Date.now(),
        launchArgs: args,
      })
      const url = await waitForUrl(id, pid)
      const state = readJson(statePath(id)) ?? {}
      if (!url) {
        const alive = pidAlive(pid)
        return {
          ok: false,
          error: alive
            ? `The host is alive on pid ${pid} but never printed its URL line within ${settings.startTimeoutMs} ms — check the log.`
            : `The host exited before it was ready. Last log lines:\n${tailText(log, 4000).split('\n').slice(-12).join('\n')}`,
          instance: await snapshot({ ...instance }, providers),
        }
      }
      writeJsonAtomic(statePath(id), { ...state, url })
      return { ok: true, warnings: prepared.warnings, instance: await snapshot(instance, providers) }
    } finally {
      starting.delete(id)
    }
  }

  async function waitForUrl(id, pid) {
    const deadline = Date.now() + settings.startTimeoutMs
    while (Date.now() < deadline) {
      const text = tailText(logPath(id))
      const matches = [...text.matchAll(URL_LINE)]
      if (matches.length) return matches[matches.length - 1][1]
      if (pid && !pidAlive(pid)) return null
      await new Promise((r) => setTimeout(r, 700))
    }
    return null
  }

  async function stop(id) {
    const state = readJson(statePath(id)) ?? {}
    const pid = state.pid
    if (!pid || !pidAlive(pid)) {
      return { ok: true, warnings: ['No live process was recorded for that instance.'] }
    }
    const kill = (signal) => {
      try {
        process.kill(-pid, signal)
        return true
      } catch {
        try {
          process.kill(pid, signal)
          return true
        } catch {
          return false
        }
      }
    }
    kill('SIGTERM')
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && pidAlive(pid)) await new Promise((r) => setTimeout(r, 250))
    if (pidAlive(pid)) kill('SIGKILL')
    const next = { ...state, pid: null, stoppedAt: Date.now() }
    writeJsonAtomic(statePath(id), next)
    return { ok: true, warnings: [`stopped pid ${pid}`] }
  }

  async function restart(id) {
    const stopped = await stop(id)
    const started = await start(id)
    return { ...started, warnings: [...(stopped.warnings ?? []), ...(started.warnings ?? [])] }
  }

  function forgetTracking(id) {
    const state = readJson(statePath(id))
    if (state) writeJsonAtomic(statePath(id), { ...state, pid: null, url: null, forgottenAt: Date.now() })
    return { ok: true, warnings: ['Dropped local tracking of the process. The Host itself keeps running; stop it from its own window.'] }
  }

  /* ---------- status ---------- */

  async function portAnswered(port, timeoutMs = 1500) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal, redirect: 'manual' })
      return [401, 200, 303, 302].includes(response.status)
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async function snapshot(instance, providers) {
    const state = readJson(statePath(instance.id)) ?? {}
    const log = logPath(instance.id)
    const alive = pidAlive(state.pid)
    // Always prefer the newest address the Host announced. A Host re-announces
    // (with a new token) every time it hot-reloads, and a superseded token is
    // refused with "dsh web authentication required" — so an address recorded at
    // start time goes stale while the process keeps running.
    const announced = [...tailText(log).matchAll(URL_LINE)].map((match) => match[1])
    const urlSource = announced.length ? 'log' : state.url ? 'state' : undefined
    const url = announced.length ? announced[announced.length - 1] : (state.url ?? null)
    if (url && url !== state.url) {
      // Self-heal the state file, so nothing reading it out of band can be
      // handed a dead address either.
      writeJsonAtomic(statePath(instance.id), { ...state, url })
    }
    const answering = await portAnswered(instance.port)
    const status = alive ? 'running' : answering ? 'error' : existsSync(profileDir(instance.home, instance.id)) ? 'provisioned' : 'missing'
    const hash = registryHash(instance, providers)
    return {
      id: instance.id,
      label: instance.label,
      port: instance.port,
      home: instance.home,
      providers: instance.providers,
      bundles: instance.bundles,
      seedEnv: instance.seedEnv,
      autostart: instance.autostart,
      default: instance.default,
      status,
      ...(state.pid && alive ? { pid: state.pid, startedAt: state.startedAt } : {}),
      ...(url ? { url, urlBase: url.replace(/[?&]token=[^&]*/gu, ''), urlSource, ...(announced.length > 1 ? { urlAnnouncements: announced.length } : {}) } : {}),
      ...(state.provisionedAt ? { provisionedAt: state.provisionedAt, provisioned: true } : { provisioned: false }),
      stale: Boolean(state.provisionHash) && state.provisionHash !== hash,
      ...(status === 'error' ? { lastError: `Something else answers HTTP on port ${instance.port} while no recorded process is alive.` } : {}),
      logTail: tailText(log, 4000).split('\n').filter(Boolean).slice(-6),
    }
  }

  async function state() {
    const { providers, instances } = registry()
    const bin = await launcher()
    const warnings = []
    const rows = []
    const ports = new Map()
    for (const instance of instances) {
      ports.set(instance.port, [...(ports.get(instance.port) ?? []), instance.id])
      rows.push(await snapshot(instance, providers))
    }
    for (const [port, ids] of ports) if (ids.length > 1) warnings.push(`Instances ${ids.join(', ')} all want port ${port}; start the second one on a different port.`)
    const selfPort = (() => {
      try {
        const url = new URL(ctx.get?.('webServer')?.getOrigin?.() ?? '')
        return Number(url.port) || undefined
      } catch {
        return undefined
      }
    })()
    if (selfPort) for (const row of rows) if (row.port === selfPort) warnings.push(`Instance "${row.id}" uses this Host's own port ${selfPort}; it will never start while you are reading this page.`)
    return {
      ok: true,
      generatedAt: Date.now(),
      guard: {
        requireSameOrigin: settings.requireSameOrigin,
        expectedOrigin: (() => {
          try {
            return ctx.get?.('webServer')?.getOrigin?.()
          } catch {
            return undefined
          }
        })(),
        rejections: guardRejections.slice(-4),
      },
      launcher: { path: bin.path, version: bin.version, wanted: bin.wanted, ok: bin.ok, ...(bin.reason ? { reason: bin.reason, installHint: bin.installHint } : {}) },
      defaults: { homeRoot: paths.homeRoot, portBase: paths.portBase, root: paths.root, openMode: settings.openMode, requireVersion: settings.requireVersion, requireSameOrigin: settings.requireSameOrigin },
      instances: rows,
      providers: providers.map((provider) => ({
        ...provider,
        ...(provider.apiKey ? { apiKey: undefined, hasKey: true } : {}),
        ...(provider.apiKeyRef ? { hasKey: true } : {}),
      })),
      warnings,
    }
  }

  /* ---------- provider endpoint probe ---------- */

  async function fetchJson(url, { headers = {}, timeoutMs = settings.probeTimeoutMs } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, { signal: controller.signal, headers })
      const text = await response.text()
      if (!response.ok) return { ok: false, error: `HTTP ${response.status} from ${url}: ${text.slice(0, 180)}` }
      try {
        return { ok: true, data: JSON.parse(text) }
      } catch {
        return { ok: false, error: `${url} answered HTTP ${response.status} but its body was not JSON (a proxy page, or the wrong port?)` }
      }
    } catch (error) {
      const reason = error?.name === 'AbortError' ? `no answer within ${timeoutMs} ms` : String(error?.cause?.message ?? error?.message ?? error)
      return { ok: false, error: `Could not reach ${url} — ${reason}` }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Resolve a credential reference for a probe. The Harness credential service
   * owns the real store (`.credentials.yaml` refs, `.env`, ambient env), so it
   * goes first; the plain-environment reads are only a fallback for profiles
   * without that service. Nothing here ever caches a value across operations.
   */
  async function resolveKey(ref) {
    if (typeof ref !== 'string' || !ref) return undefined
    const credentials = ctx.get?.('credentials')
    if (credentials?.resolve !== undefined) {
      try {
        const resolved = await credentials.resolve(ref)
        if (typeof resolved?.value === 'string' && resolved.value) return resolved.value
      } catch {}
    }
    if (process.env[ref]) return process.env[ref]
    return envValues(join(parentHome(), '.env')).get(ref)
  }

  async function probeEndpoint(body = {}) {
    const base = String(body.baseURL ?? '').trim().replace(/\/+$/u, '')
    if (!base) return { ok: false, error: 'baseURL is required.' }
    if (!/^https?:\/\//u.test(base)) return { ok: false, error: 'baseURL must start with http:// or https://' }
    const key = body.apiKey || (body.apiKeyRef ? await resolveKey(body.apiKeyRef) : undefined)
    const headers = key ? { authorization: `Bearer ${key}`, accept: 'application/json' } : { accept: 'application/json' }
    const vendor = String(body.vendor ?? body.api ?? '').trim()
    const origin = new URL(base).origin
    const attempts = []
    if (vendor === 'ollama') attempts.push([`${origin}/api/tags`, 'ollama'])
    if (vendor === 'lmstudio') attempts.push([`${origin}/api/v0/models`, 'lmstudio'])
    attempts.push([`${base}/models`, 'openai'])
    if (!/\/v1$/u.test(base)) attempts.push([`${base}/v1/models`, 'openai'])
    attempts.push([`${origin}/api/tags`, 'ollama'], [`${origin}/api/v0/models`, 'lmstudio'])
    const failures = []
    for (const [url, kind] of attempts) {
      const result = await fetchJson(url, { headers })
      if (!result.ok) {
        failures.push(result.error)
        continue
      }
      const models = extractModels(result.data, kind)
      if (!models.length) {
        failures.push(`${url} answered but listed no models`)
        continue
      }
      return { ok: true, models, source: url, attempts: attempts.length, ...(key ? { keyUsed: true } : {}) }
    }
    return { ok: false, error: `No model listing worked for ${base}: ${failures.slice(0, 3).join(' | ')}` }
  }

  function extractModels(data, kind) {
    if (!data || typeof data !== 'object') return []
    if (kind === 'ollama' && Array.isArray(data.models)) {
      return data.models
        .map((row) => ({ id: String(row?.name ?? row?.model ?? '').trim() }))
        .filter((row) => row.id)
    }
    if (kind === 'lmstudio' && Array.isArray(data.data)) {
      return data.data
        .filter((row) => !row?.type || ['llm', 'vlm', 'ocr'].includes(row.type))
        .map((row) => ({
          id: String(row?.id ?? '').trim(),
          ...(row?.published_size ? { name: `${row.id} (${(row.published_size / 1e9).toFixed(1)} GB)` } : {}),
        }))
        .filter((row) => row.id)
    }
    const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []
    return list
      .map((row) => {
        if (typeof row === 'string') return { id: row.trim() }
        const id = String(row?.id ?? row?.name ?? '').trim()
        // Strata labels each pack in `meta.label` and reports no capacity, while
        // OpenAI-style servers put the label in `name`; keep whichever exists so
        // the picker shows "Qwen3.8-Flash-Next IQ3_XS" instead of a bare alias.
        const label = row?.name ?? row?.meta?.label
        const contextWindow = Number.isInteger(row?.context_window) ? row.context_window : Number.isInteger(row?.meta?.contextWindow) ? row.meta.contextWindow : undefined
        const maxTokens = Number.isInteger(row?.max_tokens) ? row.max_tokens : Number.isInteger(row?.meta?.maxTokens) ? row.meta.maxTokens : undefined
        return {
          id,
          ...(label && String(label) !== id ? { name: String(label) } : {}),
          ...(contextWindow ? { contextWindow } : {}),
          ...(maxTokens ? { maxTokens } : {}),
        }
      })
      .filter((row) => row.id)
  }

  /* ------------------------------- one implementation, two calling surfaces */

  /**
   * Carry forward capability fields the page does not model (`reasoningEfforts`,
   * `compat`, `input`) when a model row is otherwise re-sent unchanged, so a save
   * from the Fleet page can never quietly remove a declared capability.
   */
  function rehydrate(incoming, previous) {
    if (!incoming || typeof incoming !== 'object' || !previous) return incoming
    const byId = new Map((Array.isArray(previous.models) ? previous.models : []).map((model) => [String(model?.id ?? '').trim(), model]))
    return {
      ...incoming,
      models: (Array.isArray(incoming.models) ? incoming.models : []).map((model) => {
        const kept = model ? byId.get(String(model.id ?? '').trim()) : undefined
        if (!kept) return model
        const carried = {}
        for (const field of ['reasoningEfforts', 'compat', 'input']) {
          if (!(field in (model ?? {})) && field in kept) carried[field] = kept[field]
        }
        return { ...model, ...carried }
      }),
    }
  }

  const operations = {
    async list() {
      return state()
    },
    async save(body = {}) {
      const current = registry()
      const previousByName = new Map(current.providers.map((p) => [p.name, p]))
      const next = {
        providers: body.providers === undefined ? current.providers : (Array.isArray(body.providers) ? body.providers : []).map((row) => normalizeProvider(rehydrate(row, previousByName.get(slug(row?.name))))).filter(Boolean),
        instances: body.instances === undefined ? current.instances : (Array.isArray(body.instances) ? body.instances : []).map((row, index) => normalizeInstance(row, index, paths)).filter((row) => row.id),
      }
      const seen = new Set()
      const warnings = []
      for (const instance of next.instances) {
        if (seen.has(instance.port)) warnings.push(`Two instances ask for port ${instance.port}; the second one will refuse to start.`)
        seen.add(instance.port)
        for (const ref of instance.providers) {
          if (ref !== '*' && !next.providers.some((p) => p.name === ref)) warnings.push(`Instance "${instance.id}" names provider "${ref}", which the registry does not define.`)
        }
        if (instance.default?.provider && !next.providers.some((p) => p.name === instance.default.provider)) {
          warnings.push(`Instance "${instance.id}" defaults to provider "${instance.default.provider}", which the registry does not define.`)
        }
      }
      for (const instance of next.instances) {
        if (instance.default?.model && instance.default.provider) {
          const provider = next.providers.find((p) => p.name === instance.default.provider)
          if (provider?.models.length && !provider.models.some((m) => m.id === instance.default.model)) {
            warnings.push(`Model "${instance.default.model}" is not in provider "${provider.name}"'s list — it may still work if that server serves it without advertising it.`)
          }
          const model = provider?.models.find((m) => m.id === instance.default.model)
          if (model && instance.default.reasoningEffort && (model.reasoningEfforts === undefined || model.reasoningEfforts === false)) {
            warnings.push(`Instance "${instance.id}" asks for reasoning effort "${instance.default.reasoningEffort}" but model "${model.id}" declares none — the turn fails with UNSUPPORTED_REASONING_EFFORT. Clear the effort in the editor, or declare the levels that pack accepts in its model line.`)
          }
        }
      }
      const saved = await persist(next)
      return { ok: true, instances: saved.instances, providers: saved.providers.map((p) => ({ ...p, apiKey: undefined })), warnings }
    },
    async delete(body = {}) {
      const kind = body.kind === 'providers' || body.kind === 'provider' ? 'provider' : body.kind === 'instance' ? 'instance' : null
      const id = slug(body.id)
      if (!kind || !id) return { ok: false, error: 'delete needs {kind: "instance"|"provider", id}.' }
      const current = registry()
      if (kind === 'instance') {
        if (!current.instances.some((row) => row.id === id)) return { ok: false, error: `No instance "${id}" to remove.` }
        await persist({ ...current, instances: current.instances.filter((row) => row.id !== id) })
        return { ok: true, warning: 'The registry row was removed. Its home and profile on disk were left alone; delete them yourself if you want them gone.' }
      }
      if (!current.providers.some((row) => row.name === id)) return { ok: false, error: `No provider "${id}" to remove.` }
      const stillUsed = current.instances.filter((row) => row.providers.includes(id) || row.default?.provider === id).map((row) => row.id)
      await persist({ ...current, providers: current.providers.filter((row) => row.name !== id) })
      return { ok: true, warning: stillUsed.length ? `Provider removed, but instances ${stillUsed.join(', ')} still point at it.` : 'Provider removed.' }
    },
    async action(body = {}) {
      const id = slug(body.id)
      if (!id) return { ok: false, error: 'action needs an instance id.' }
      switch (body.action) {
        case 'provision':
        case 'provision-instance':
          return provision(id)
        case 'start':
          return start(id)
        case 'stop':
          return stop(id)
        case 'restart':
          return restart(id)
        case 'forget':
          return forgetTracking(id)
        case 'probe-instance': {
          const { providers, instances } = registry()
          const instance = instances.find((row) => row.id === id)
          if (!instance) return { ok: false, error: `No fleet instance "${id}" in the registry.` }
          return { ok: true, instance: await snapshot(instance, providers) }
        }
        default:
          return { ok: false, error: `Unknown action "${body.action}". Use provision, start, stop, restart, probe-instance, or forget.` }
      }
    },
    async logs(query = {}) {
      const id = slug(query.id)
      if (!id) return { ok: false, error: 'logs needs an instance id.' }
      const path = logPath(id)
      return { ok: Boolean(readText(path)), lines: tailText(path).split('\n').filter(Boolean).slice(-MAX_STATE_LINES), path }
    },
    async probe(body = {}) {
      return probeEndpoint(body)
    },
    async openUrl(body = {}) {
      const { providers, instances } = registry()
      const instance = instances.find((row) => row.id === slug(body.id))
      if (!instance) return { ok: false, error: `No fleet instance "${body.id}" in the registry.` }
      const snapshotRow = await snapshot(instance, providers)
      if (snapshotRow.status !== 'running') return { ok: false, error: 'That instance is not running yet — start it first.', instance: snapshotRow }
      if (settings.openMode === 'browser' || !snapshotRow.url) {
        return { ok: Boolean(snapshotRow.url), ...(snapshotRow.url ? { url: snapshotRow.url } : { error: 'No URL was captured for that instance yet; open its log.' }), openMode: settings.openMode }
      }
      if (settings.openMode === 'none') return { ok: true, url: snapshotRow.url, openMode: settings.openMode }
      // `tab` is the default because it reuses the browser that is already
      // running: `open <url>` asks the system default browser for one new tab.
      // `chrome-app` instead spawns a dedicated Chrome instance so the member
      // gets its own window without browser chrome — and a second instance can
      // bring its own startup window with it, which is why it is opt-in.
      const command = settings.openMode === 'chrome-app' ? 'open' : 'open'
      const args = settings.openMode === 'chrome-app'
        ? ['-na', 'Google Chrome', '--args', `--app=${snapshotRow.url}`]
        : [snapshotRow.url]
      if (settings.openMode === 'chrome-app') {
        if (process.platform !== 'darwin') return { ok: false, error: `openMode "chrome-app" is only implemented on macOS here — open this address in a browser: ${snapshotRow.url}`, url: snapshotRow.url }
        if (!existsSync('/Applications/Google Chrome.app')) return { ok: false, error: `Google Chrome was not found in /Applications. Open the address yourself: ${snapshotRow.url}`, url: snapshotRow.url }
      }
      const launched = await new Promise((resolve) => {
        let child
        try {
          child = spawn(command, args, { stdio: 'ignore', detached: true })
        } catch (error) {
          return resolve({ ok: false, error: String(error?.message ?? error) })
        }
        child.once('error', (error) => resolve({ ok: false, error: `Could not ask the system to open the address: ${error?.message ?? error}` }))
        child.once('spawn', () => {
          child.unref()
          resolve({ ok: true })
        })
      })
      if (!launched.ok) return { ...launched, url: snapshotRow.url }
      return {
        ok: true,
        warnings: [settings.openMode === 'chrome-app'
          ? 'Opened a dedicated Chrome application window (openMode: chrome-app) — this starts a second Chrome instance, which may show its own startup window.'
          : 'Opened this instance in a new tab of your default browser (openMode: tab).'],
      }
    },
    async installRuntime() {
      const wanted = hostVersion()
      const npmExecpath = process.env.npm_execpath
      const useNodeWrapper = typeof npmExecpath === 'string' && npmExecpath.endsWith('.js')
      const command = useNodeWrapper ? process.execPath : 'npm'
      const args = [
        ...(useNodeWrapper ? [npmExecpath] : []),
        'install',
        '--prefix',
        join(paths.root, 'cli'),
        '--no-audit',
        '--no-fund',
        '--loglevel=warn',
        `@deepseek-ai/dsh@${wanted ?? 'latest'}`,
      ]
      mkdirSync(paths.root, { recursive: true })
      return new Promise((resolve) => {
        let child
        try {
          child = spawn(command, args, { cwd: paths.root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (error) {
          return resolve({ ok: false, error: `Could not run npm: ${error?.message ?? error}` })
        }
        const lines = []
        child.stdout.on('data', (chunk) => lines.push(String(chunk)))
        child.stderr.on('data', (chunk) => lines.push(String(chunk)))
        child.on('error', (error) => resolve({ ok: false, error: String(error?.message ?? error) }))
        child.on('close', (code) => {
          launcherCache = { at: 0, value: null }
          resolve({ ok: code === 0, exit: code, output: lines.join('').split('\n').filter(Boolean).slice(-25).join('\n') })
        })
      })
    },
  }

  /* ------------------------------------- HTTP surface (the page calls these) */

  const web = ctx.get?.('webServer')
  if (web !== undefined) {
    const send = (res, status, body) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(payload)
    }
    /**
     * Mutating routes are guarded by same-origin evidence. This Host's plugin
     * routes are not carried by the `connection` auth that protects `/` and
     * `/api` (they answer for any client that can reach the port), and these
     * operations launch processes and rewrite profile patches — so a request
     * must prove it came from this page: a browser always sends
     * `sec-fetch-site: same-origin` and, for POST, an `origin` matching ours.
     * curl and a cross-site page cannot produce both.
     */
    const ourOrigin = () => {
      try {
        const value = web.getOrigin?.() ?? ctx.get?.('webServer')?.getOrigin?.()
        return typeof value === 'string' ? value.replace(/\/+$/u, '') : undefined
      } catch {
        return undefined
      }
    }
    const sameOriginOk = (req) => {
      if (settings.requireSameOrigin === false) return true
      const headers = req?.headers ?? {}
      const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
      // Strongest available proof that this came from this Host's own page: the
      // launch-token exchange mints an `HttpOnly; SameSite=Strict` cookie named
      // `dsh-auth-<hash of authority>`. A cross-site page can neither read it nor
      // make the browser send it, and no script can set a Cookie header by hand,
      // so its presence means "the browser session this Host itself issued".
      const hasCookie = /dsh-auth-[A-Za-z0-9_-]{8,}/u.test(String(headers.cookie ?? ''))
      const expected = ourOrigin()
      const origin = String(headers.origin ?? headers.referer ?? '').replace(/\/+$/u, '')
      if (site === 'same-origin' || hasCookie || (expected && origin && (origin === expected || authorityMatch(origin, expected)))) {
        return true
      }
      const authority = authorityOf(headers.host)
      guardRejections.push({
        at: Date.now(),
        path: req?.url,
        origin: origin || undefined,
        secFetchSite: site || undefined,
        referer: headers.referer ? String(headers.referer) : undefined,
        hasSessionCookie: hasCookie,
        requestAuthority: authority ? `${authority.host}:${authority.port}` : undefined,
        expectedOrigin: expected ?? undefined,
        expectedUnavailable: expected === undefined,
        enforced: settings.requireSameOrigin !== 'observe',
      })
      if (guardRejections.length > 8) guardRejections.shift()
      // `observe` records the evidence without refusing, so a mismatch is read
      // from the state route instead of guessed at.
      return settings.requireSameOrigin === 'observe'
    }
    const withBody = (req, res, handler) => {
      let raw = ''
      let overflow = false
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > MAX_BODY_BYTES) {
          overflow = true
          req.destroy()
        }
      })
      req.on('end', async () => {
        if (overflow) return send(res, 413, { ok: false, error: 'Body too large.' })
        const body = parseBody(raw)
        if (body === null) return send(res, 400, { ok: false, error: 'Body must be JSON.' })
        try {
          return send(res, 200, await handler(body))
        } catch (error) {
          return send(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
      })
      req.on('error', () => {
        if (!res.writableEnded) send(res, 400, { ok: false, error: 'Request failed.' })
      })
    }
    const routes = [
      ['/fleet/api/state', 'GET', async () => {
        try {
          return await operations.list()
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) }
        }
      }],
      ['/fleet/api/action', 'POST', (body) => operations.action(body)],
      ['/fleet/api/save', 'POST', (body) => operations.save(body)],
      ['/fleet/api/delete', 'POST', (body) => operations.delete(body)],
      ['/fleet/api/probe', 'POST', (body) => operations.probe(body)],
      ['/fleet/api/logs', 'GET', async (body, req) => operations.logs(parseQuery(req))],
      ['/fleet/api/open', 'POST', (body) => operations.openUrl(body)],
      ['/fleet/api/install-runtime', 'POST', () => operations.installRuntime()],
    ]
    for (const [path, method, handler] of routes) {
      ctx.effect(
        () =>
          web.register({
            kind: 'exact',
            path,
            handler: async (req, res) => {
              if (req.method !== method) return send(res, 405, { ok: false, error: `${method} required` })
              if (method === 'GET') {
                try {
                  return send(res, 200, await handler({}, req))
                } catch (error) {
                  return send(res, 200, { ok: false, error: String(error?.message ?? error) })
                }
              }
              if (!sameOriginOk(req)) {
                return send(res, 403, { ok: false, error: 'Fleet operations are accepted only from this Host’s own page (same-origin evidence). Run them from the Fleet page or the `fleet` tool; the headers that were seen are reported under `guard.rejections` in the Fleet state, and `requireSameOrigin: false` on the fleet row turns this guard off.' })
              }
              return withBody(req, res, handler)
            },
          }),
        `dsh-fleet ${path}`,
      )
    }
  }

  function parseQuery(req) {
    try {
      const url = new URL(req?.url ?? '/', 'http://127.0.0.1')
      return Object.fromEntries(url.searchParams.entries())
    } catch {
      return {}
    }
  }

  /* ------------------------------------------- Tool surface (the agent calls) */

  /** Tool results must be lossless JSON: strip undefined values and NaN. */
  function plain(value) {
    try {
      return JSON.parse(JSON.stringify(value ?? null))
    } catch {
      return { ok: false, error: 'fleet returned a non-serializable result' }
    }
  }

  /** Keep the tool's rendered line short; the full object is still returned. */
  function summarizeResult(value) {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value.instances)) {
      return {
        ...value,
        instances: value.instances.map((row) => `${row.id} · :${row.port} · ${row.status}${row.pid ? ` pid ${row.pid}` : ''} · ${row.default?.provider ?? '-'}/${row.default?.model ?? '-'}`),
      }
    }
    if (Array.isArray(value.lines)) return { ...value, lines: `${value.lines.length} log lines` }
    if (Array.isArray(value.models)) return { ...value, models: `${value.models.length} models: ${value.models.slice(0, 12).map((model) => model.id).join(', ')}` }
    return value
  }

  async function dispatch(params) {
    switch (params.action) {
      case 'list':
        return operations.list()
      case 'save':
        return operations.save(params)
      case 'delete':
        return operations.delete(params)
      case 'action':
        return operations.action({ id: params.id, action: params.op })
      case 'logs': {
        const result = await operations.logs({ id: params.id })
        if (Array.isArray(result.lines) && params.limit) result.lines = result.lines.slice(-Math.max(1, Math.min(400, params.limit)))
        return result
      }
      case 'probe':
        return operations.probe(params)
      case 'open-url':
        return operations.openUrl(params)
      case 'install-runtime':
        return operations.installRuntime()
      default:
        return { ok: false, error: `Unknown action "${params.action}".` }
    }
  }

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'fleet',
        description:
          'Manage the fleet of concurrent DSH hosts defined by dsh-plugin-fleet. Each instance is a separate `dsh --profile web` process with its own DSH_HOME, port, provider routes and default model. '
          + 'list returns the registry plus live status; save replaces {instances} and/or {providers} (omit a key to leave it alone); delete removes one row; '
          + 'action runs provision|start|stop|restart|probe-instance|forget on one instance; logs reads its stdout; probe tests a provider endpoint and returns its models; '
          + 'open-url returns the tokenized URL to open (or opens a Chrome app window when openMode=chrome-app); install-runtime installs the matching `dsh` CLI under the fleet root when the launcher version drifts. '
          + 'Provider secrets are never written into YAML: a literal apiKey is seeded into the instance `.env` and referenced as apiKeyEnv.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'save', 'delete', 'action', 'logs', 'probe', 'open-url', 'install-runtime'],
            },
            id: { type: 'string', description: 'instance id (slug) for action, logs, open-url; row id for delete' },
            op: { type: 'string', enum: ['provision', 'start', 'stop', 'restart', 'probe-instance', 'forget'], description: 'for action=action' },
            instances: { type: 'array', description: 'for save: the complete replacement instance list', items: { type: 'object' } },
            providers: { type: 'array', description: 'for save: the complete replacement provider list', items: { type: 'object' } },
            kind: { type: 'string', enum: ['instance', 'provider'], description: 'for delete' },
            baseURL: { type: 'string', description: 'for probe' },
            apiKey: { type: 'string', description: 'for probe: bearer to test with' },
            apiKeyRef: { type: 'string', description: 'for probe: credential/environment reference to read' },
            vendor: { type: 'string', description: 'for probe: ollama | lmstudio | openai hints the listing dialect' },
            limit: { type: 'number', description: 'for logs: lines from the end' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              error: { type: 'string' },
              instances: { type: 'array' },
              providers: { type: 'array' },
              instance: { type: 'object' },
              warnings: { type: 'array' },
              models: { type: 'array' },
              lines: { type: 'array' },
              url: { type: 'string' },
            },
            additionalProperties: true,
          },
          render: (args, value) => [
            {
              type: 'text',
              text: `fleet ${args?.action ?? ''} ${args?.id ? `"${args.id}"` : ''} ${value?.ok ? '✓' : value?.error ? `— ${String(value.error).slice(0, 300)}` : ''}\n${String(
                value?.output ?? JSON.stringify(summarizeResult(value), null, 1) ?? '',
              ).slice(0, 6000)}`,
            },
          ],
        },
        isConcurrencySafe: (args) => ['list', 'logs', 'probe'].includes(args?.action),
        async execute(params) {
          try {
            return plain(await dispatch(params))
          } catch (error) {
            return plain({ ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    'dsh-fleet tool',
  )

  /* --------------------------------------------- autostart of pinned hosts */

  if (settings.autostartOnBoot) {
    for (const instance of registry().instances.filter((row) => row.autostart)) {
      const timer = setTimeout(() => {
        void start(instance.id).then((result) => {
          if (!result.ok) console.warn(`dsh-fleet: autostart of "${instance.id}" failed: ${result.error}`)
        })
      }, 4000)
      // The disposer keeps a pending autostart from outliving this fiber.
      ctx.effect(() => () => clearTimeout(timer), `dsh-fleet autostart ${instance.id}`)
    }
  }
}
