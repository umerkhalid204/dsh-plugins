/**
 * dsh-fleet — Client half.
 *
 * A "Fleet" sidebar panel plus the central Fleet page: the launcher health, the
 * instance table (live status, Open/Start/Stop/Restart/Provision/Logs and the
 * editors) and the shared provider catalog. Every value on this page comes from
 * this bundle's Host routes (/fleet/api/*) — there is no second source of truth
 * here, and every fetch failure is rendered as a red line instead of thrown, so
 * the page still works before the Host half exists.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-fleet',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const ROUTES = {
      state: '/fleet/api/state',
      action: '/fleet/api/action',
      save: '/fleet/api/save',
      del: '/fleet/api/delete',
      probe: '/fleet/api/probe',
      logs: '/fleet/api/logs',
      open: '/fleet/api/open',
      install: '/fleet/api/install-runtime',
    }

    const PAGE_MS = 4000
    const PANEL_MS = 15000
    const LOGS_MS = 5000

    const API_KINDS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'ollama', 'lmstudio']
    const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh']
    const SLUG = /^[a-z0-9-]{2,40}$/

    const CSS = `
.fl-root { display:flex; flex-direction:column; gap:12px; height:100%; overflow:auto; padding:16px 18px 26px;
  color:var(--dsw-alias-label-primary); font-size:13px; }
.fl-head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
.fl-title { font-size:17px; font-weight:600; }
.fl-sub { color:var(--dsw-alias-label-secondary); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fl-spacer { flex:1 1 auto; }
.fl-btn { border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary); border-radius:6px; padding:5px 11px; font-size:12px; cursor:pointer; }
.fl-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }
.fl-btn:disabled { opacity:.45; cursor:default; }
.fl-btn-sm { padding:3px 8px; font-size:11.5px; border-radius:6px; }
.fl-btn-brand { color:var(--dsw-alias-brand-primary); }
.fl-btn-danger { color:var(--dsw-alias-state-error-primary); }
.fl-panel { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px; overflow:hidden; }
.fl-panel-head { padding:9px 12px; border-bottom:1px solid var(--dsw-alias-border-l1);
  display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-weight:600; font-size:12.5px; }
.fl-table { width:100%; border-collapse:collapse; font-size:12.5px; }
.fl-table th { text-align:left; font-weight:500; color:var(--dsw-alias-label-secondary);
  padding:6px 9px; border-bottom:1px solid var(--dsw-alias-border-l1); white-space:nowrap; }
.fl-table td { padding:6px 9px; border-bottom:1px solid var(--dsw-alias-border-l1); vertical-align:top; }
.fl-table tr:last-child td { border-bottom:none; }
.fl-actions { display:flex; gap:4px; flex-wrap:wrap; }
.fl-pill { border:1px solid var(--dsw-alias-border-l1); background:transparent; border-radius:999px;
  padding:2px 9px; font-size:11.5px; display:inline-block; white-space:nowrap; cursor:pointer; }
.fl-pill:disabled { cursor:default; opacity:.7; }
.fl-pill-running { color:var(--dsw-alias-state-success-primary); }
.fl-pill-down { color:var(--dsw-alias-state-idle-primary); }
.fl-pill-error { color:var(--dsw-alias-state-error-primary); }
.fl-pill-provisioned { color:var(--dsw-alias-brand-primary); }
.fl-pill-missing { color:var(--dsw-alias-state-warn-primary); }
.fl-label { font-weight:500; }
.fl-muted { color:var(--dsw-alias-label-secondary); }
.fl-mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11.5px; }
.fl-num { font-variant-numeric:tabular-nums; }
.fl-err { border:1px solid var(--dsw-alias-state-error-primary); border-radius:8px;
  padding:9px 11px; color:var(--dsw-alias-state-error-primary); font-size:12.5px;
  display:flex; flex-direction:column; gap:4px; }
.fl-warn { border:1px solid var(--dsw-alias-border-l1); border-left:3px solid var(--dsw-alias-state-warn-primary);
  border-radius:8px; padding:9px 11px; font-size:12.5px; display:flex; flex-direction:column; gap:4px; }
.fl-note { border:1px solid var(--dsw-alias-border-l1); border-left:3px solid var(--dsw-alias-brand-primary);
  border-radius:8px; padding:9px 11px; font-size:12.5px; color:var(--dsw-alias-label-secondary); }
.fl-ok { color:var(--dsw-alias-state-success-primary); font-size:12.5px; }
.fl-line-error { color:var(--dsw-alias-state-error-primary); font-size:11.5px; margin-top:3px; }
.fl-line-warn { color:var(--dsw-alias-state-warn-primary); font-size:11.5px; margin-top:3px; }
.fl-empty { padding:13px 12px; color:var(--dsw-alias-label-secondary); }
.fl-scrim { position:fixed; inset:0; display:flex; justify-content:flex-end; z-index:40; }
.fl-drawer { width:min(560px,94vw); height:100%; display:flex; flex-direction:column;
  background:var(--dsw-alias-bg-layer-1); border-left:1px solid var(--dsw-alias-border-l2); }
.fl-drawer-head { padding:11px 14px; border-bottom:1px solid var(--dsw-alias-border-l1);
  display:flex; align-items:center; gap:8px; }
.fl-drawer-title { font-size:14px; font-weight:600; }
.fl-drawer-body { flex:1 1 auto; overflow:auto; padding:13px 14px; display:flex; flex-direction:column; gap:12px; }
.fl-drawer-foot { padding:10px 14px; border-top:1px solid var(--dsw-alias-border-l1);
  display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.fl-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(215px,1fr)); gap:10px; }
.fl-field { display:flex; flex-direction:column; gap:4px; }
.fl-field-label { font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.fl-hint { font-size:11px; color:var(--dsw-alias-label-secondary); }
.fl-input, .fl-select { border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary); border-radius:6px; padding:5px 8px; font-size:12.5px; }
.fl-textarea { border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary); border-radius:6px; padding:6px 8px; font-size:11.5px;
  font-family:ui-monospace, SFMono-Regular, Menlo, monospace; min-height:130px; resize:vertical; }
.fl-check { display:flex; align-items:flex-start; gap:6px; font-size:12.5px; }
.fl-check input, .fl-check-input { accent-color:var(--dsw-alias-brand-primary); margin-top:2px; }
.fl-check-input { font-size:12.5px; }
.fl-list { display:flex; flex-direction:column; gap:6px; border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px; padding:9px; background:var(--dsw-alias-bg-layer-2); }
.fl-logbox { flex:1 1 auto; overflow:auto; background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:8px 10px;
  font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11.5px; line-height:1.45;
  white-space:pre-wrap; word-break:break-word; }
.fl-output { flex:0 0 auto; max-height:190px; }
.fl-link { color:var(--dsw-alias-brand-primary); text-decoration:none; }
.fl-link:hover { text-decoration:underline; }
.fl-kv { display:flex; flex-direction:column; gap:3px; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
`

    const PANEL_CSS = `
.fl-panel-icon { position:relative; display:inline-flex; width:18px; height:18px; }
.fl-dot { position:absolute; right:-2px; bottom:-2px; width:7px; height:7px; border-radius:999px;
  background:var(--dsw-alias-state-success-primary); border:1px solid var(--dsw-alias-bg-layer-1); }
`

    // ---------- defensive readers: every contract field may be absent ----------
    const arr = (value) => (Array.isArray(value) ? value : [])
    const str = (value) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))
    const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null)
    const asNumber = (value) => {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? n : null
    }

    function toMillis(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value)
        return Number.isNaN(parsed) ? null : parsed
      }
      return null
    }

    function fmtUptime(startedAt) {
      const ms = toMillis(startedAt)
      if (ms === null) return ''
      const secs = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (secs < 60) return `${secs}s`
      const mins = Math.floor(secs / 60)
      if (mins < 60) return `${mins}m`
      const hours = Math.floor(mins / 60)
      if (hours < 48) return `${hours}h ${mins % 60}m`
      const days = Math.floor(hours / 24)
      return `${days}d ${hours % 24}h`
    }

    function fmtClock(ms) {
      const value = toMillis(ms)
      return value === null ? '' : new Date(value).toLocaleTimeString()
    }

    // ---------- one fetch helper: never throws, always {ok,data} or {ok,error} ----------
    async function requestJson({ path, method = 'GET', body, signal }) {
      try {
        const response = await fetch(path, {
          method,
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        })
        const text = await response.text()
        let parsed = null
        if (text) {
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = null
          }
        }
        if (parsed === null) {
          const suffix = response.status === 404
            ? ' — the fleet Host routes are not installed in this profile yet.'
            : ''
          return { ok: false, error: `Fleet ${method} ${path} answered HTTP ${response.status}${suffix}` }
        }
        if (parsed.ok === false) {
          return { ok: false, error: str(parsed.error) || `Fleet ${method} ${path} reported a failure.` }
        }
        if (!response.ok) {
          return { ok: false, error: `Fleet ${method} ${path} answered HTTP ${response.status} without an error field.` }
        }
        return { ok: true, data: parsed }
      } catch (error) {
        if (error && error.name === 'AbortError') return { ok: false, aborted: true, error: '' }
        return { ok: false, error: str(error && error.message) || str(error) || 'Request failed.' }
      }
    }

    // ---------- shared state store + the only two pollers in this file ----------
    const store = {
      data: null,
      error: '',
      loading: false,
      fetchedAt: 0,
      listeners: new Set(),
      kinds: new Map(),
      timer: 0,
      intervalMs: 0,
      controller: null,
      inFlight: false,
      pending: false,
      started: false,
      visibilityBound: false,
    }

    function snapshot() {
      return { data: store.data, error: store.error, loading: store.loading, fetchedAt: store.fetchedAt }
    }

    function notify() {
      for (const listener of Array.from(store.listeners)) listener(snapshot())
    }

    async function refresh() {
      if (store.inFlight) {
        store.pending = true
        return
      }
      store.inFlight = true
      store.loading = true
      const controller = new AbortController()
      store.controller = controller
      const result = await requestJson({ path: ROUTES.state, signal: controller.signal })
      store.inFlight = false
      store.loading = false
      if (store.controller === controller) store.controller = null
      if (result.aborted) {
        notify()
        return
      }
      if (!result.ok) {
        store.error = result.error
        notify()
        return
      }
      store.data = result.data
      store.error = ''
      store.fetchedAt = Date.now()
      notify()
      if (store.pending) {
        store.pending = false
        void refresh()
      }
    }

    function desiredCadence() {
      let ms = 0
      for (const kind of Array.from(store.kinds.values())) {
        const pageVisible = kind !== 'page' || (typeof document === 'undefined' || document.visibilityState === 'visible')
        if (!pageVisible) continue
        const want = kind === 'page' ? PAGE_MS : PANEL_MS
        ms = ms === 0 ? want : Math.min(ms, want)
      }
      return ms
    }

    function retune() {
      const wasIdle = store.intervalMs === 0
      const ms = desiredCadence()
      if (ms === store.intervalMs) return
      if (store.timer !== 0) {
        clearInterval(store.timer)
        store.timer = 0
      }
      store.intervalMs = ms
      if (ms > 0) {
        store.timer = setInterval(() => { void refresh() }, ms)
        if (wasIdle) void refresh()
      }
    }

    function onVisibility() {
      retune()
    }

    function startPolling() {
      if (store.started) return
      store.started = true
      if (typeof document !== 'undefined' && !store.visibilityBound) {
        document.addEventListener('visibilitychange', onVisibility)
        store.visibilityBound = true
      }
      retune()
    }

    function stopPolling() {
      if (store.timer !== 0) {
        clearInterval(store.timer)
        store.timer = 0
      }
      store.intervalMs = 0
      const controller = store.controller
      store.controller = null
      if (controller) controller.abort()
      if (store.visibilityBound && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
        store.visibilityBound = false
      }
      store.listeners.clear()
      store.kinds.clear()
      store.started = false
    }

    function subscribeStore(listener, kind) {
      store.listeners.add(listener)
      store.kinds.set(listener, kind)
      listener(snapshot())
      retune()
      return () => {
        store.listeners.delete(listener)
        store.kinds.delete(listener)
        retune()
      }
    }

    function useFleetStore(kind) {
      const [value, setValue] = useState(snapshot)
      useEffect(() => subscribeStore(setValue, kind), [kind])
      return value
    }

    // ---------- registry projections: only fields this page actually owns ----------
    // `save` is a full replacement, so untouched rows are re-sent, but never with
    // live-only fields (status, pid, logTail, url) and never with booleans the
    // Host did not report — omitting those keeps the Host's own default.
    function projectModel(model) {
      const out = { id: str(model && model.id) }
      if (str(model && model.name)) out.name = str(model.name)
      const contextWindow = asNumber(model && model.contextWindow)
      if (contextWindow !== null) out.contextWindow = contextWindow
      const maxTokens = asNumber(model && model.maxTokens)
      if (maxTokens !== null) out.maxTokens = maxTokens
      if (Array.isArray(model && model.input)) out.input = arr(model.input).map(str).filter(Boolean)
      return out
    }

    function projectProvider(provider) {
      const out = { name: str(provider && provider.name) }
      if (str(provider && provider.label)) out.label = str(provider.label)
      if (str(provider && provider.api)) out.api = str(provider.api)
      if (str(provider && provider.baseURL)) out.baseURL = str(provider.baseURL)
      if (str(provider && provider.apiKey)) out.apiKey = str(provider.apiKey)
      if (str(provider && provider.apiKeyRef)) out.apiKeyRef = str(provider.apiKeyRef)
      if (Array.isArray(provider && provider.models)) out.models = arr(provider.models).map(projectModel)
      return out
    }

    function projectInstance(instance) {
      const out = { id: str(instance && instance.id) }
      if (str(instance && instance.label)) out.label = str(instance.label)
      const port = asNumber(instance && instance.port)
      if (port !== null) out.port = port
      if (str(instance && instance.home)) out.home = str(instance.home)
      if (typeof instance.autostart === 'boolean') out.autostart = instance.autostart
      if (typeof instance.seedEnv === 'boolean') out.seedEnv = instance.seedEnv
      if (Array.isArray(instance.providers)) out.providers = arr(instance.providers).map(str).filter(Boolean)
      if (Array.isArray(instance.bundles)) out.bundles = arr(instance.bundles).map(str).filter(Boolean)
      const shared = obj(instance.default)
      if (shared) {
        const def = {}
        if (str(shared.provider)) def.provider = str(shared.provider)
        if (str(shared.model)) def.model = str(shared.model)
        if (str(shared.reasoningEffort)) def.reasoningEffort = str(shared.reasoningEffort)
        out.default = def
      }
      return out
    }

    // ---------- controls ----------
    function Icon({ size, active }) {
      const edge = size || 18
      return h('svg', {
        width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.72 },
      },
        h('rect', { x: 3.5, y: 4, width: 17, height: 6.5, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('rect', { x: 3.5, y: 13.5, width: 17, height: 6.5, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('circle', { cx: 6.8, cy: 7.25, r: 1, fill: 'currentColor' }),
        h('circle', { cx: 6.8, cy: 16.75, r: 1, fill: 'currentColor' }),
        h('path', { d: 'M11 7.25h6M11 16.75h6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      )
    }

    // The sidebar row stays a pure icon so the rail layout is untouched; it only
    // adds a live dot driven by the 15 s panel poll.
    function Panel({ size, active }) {
      const { data } = useFleetStore('panel')
      const instances = arr(data && data.instances)
      const running = instances.filter((instance) => str(instance && instance.status) === 'running').length
      return h(React.Fragment, null,
        h('style', null, PANEL_CSS),
        h('span', { className: 'fl-panel-icon', style: { width: size, height: size } },
          h(Icon, { size, active }),
          running > 0 ? h('span', { className: 'fl-dot', 'aria-hidden': true }) : null))
    }

    function TextInput({ value, onChange, placeholder, type, mono, title }) {
      return h('input', {
        className: mono ? 'fl-input fl-mono' : 'fl-input',
        type: type || 'text',
        value,
        placeholder: placeholder || '',
        title: title || undefined,
        spellcheck: false,
        autoComplete: 'off',
        onChange: (event) => onChange(event.target.value),
      })
    }

    function Select({ value, onChange, options, title, disabled }) {
      return h('select', {
        className: 'fl-select',
        value,
        title: title || undefined,
        disabled: disabled === true,
        onChange: (event) => onChange(event.target.value),
      }, ...options.map((option) => h('option', { key: `${option.value}`, value: option.value }, option.label)))
    }

    function Field({ label, hint, children }) {
      return h('div', { className: 'fl-field' },
        label ? h('label', { className: 'fl-field-label' }, label) : null,
        children,
        hint ? h('div', { className: 'fl-hint' }, hint) : null)
    }

    function Checkbox({ checked, onChange, label, hint, disabled }) {
      return h('label', { className: 'fl-check' },
        h('input', {
          type: 'checkbox', checked: checked === true, disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', null, label, hint ? h('div', { className: 'fl-hint' }, hint) : null))
    }

    function Drawer({ title, subtitle, onClose, children, footer }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h('div', {
        className: 'fl-scrim',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      },
        h('aside', { className: 'fl-drawer', role: 'dialog', 'aria-modal': true, 'aria-label': title },
          h('div', { className: 'fl-drawer-head' },
            h('div', { className: 'fl-drawer-title' }, title),
            subtitle ? h('div', { className: 'fl-sub' }, subtitle) : null,
            h('div', { className: 'fl-spacer' }),
            h('button', { className: 'fl-btn fl-btn-sm', onClick: onClose, title: 'Close (Escape)' }, 'Close')),
          h('div', { className: 'fl-drawer-body' }, children),
          footer ? h('div', { className: 'fl-drawer-foot' }, footer) : null))
    }

    function StatusPill({ instance, busy, onProbe }) {
      const raw = str(instance && instance.status) || 'unknown'
      const known = ['running', 'down', 'provisioned', 'missing', 'error'].includes(raw)
      const label = known ? raw : raw === 'unknown' ? 'unknown' : `unknown (${raw})`
      const tail = arr(instance && instance.logTail).map(str).filter(Boolean)
      const detail = str(instance && instance.lastError) || (tail.length ? tail[tail.length - 1] : '') ||
        (known ? `Status reported by the Host: ${raw}. Click to re-check this instance only.`
          : 'The Host did not report a status for this instance. Click to re-check it.')
      const tip = (instance && instance.portBusy === true
        ? `Port ${str(instance.port) || 'the assigned port'} is busy on this host. `
        : '') + detail
      return h('button', {
        className: known ? `fl-pill fl-pill-${raw}` : 'fl-pill fl-pill-down',
        title: tip,
        disabled: busy === true,
        onClick: () => onProbe(instance),
      }, busy === true ? 'checking…' : label)
    }

    // ---------- instance editor ----------
    function newInstanceId(instances) {
      const taken = new Set(instances.map((instance) => str(instance && instance.id)))
      let n = 1
      while (taken.has(`instance-${n}`) && n < 100) n += 1
      return `instance-${n}`
    }

    function makeInstanceDraft(source, defaults, instances, fresh) {
      const homeRoot = str(defaults && defaults.homeRoot).replace(/\/+$/, '')
      const portBase = asNumber(defaults && defaults.portBase)
      const index = instances.length
      const id = fresh ? newInstanceId(instances) : str(source && source.id)
      const label = fresh ? `${str(source && source.label) || id} copy` : str(source && source.label) || id
      const port = asNumber(source && source.port)
      return {
        id,
        label,
        port: String(port !== null ? port : (portBase === null ? 3101 + index : portBase + index)),
        home: str(source && source.home) || (homeRoot && id ? `${homeRoot}/${id}` : ''),
        autostart: source && typeof source.autostart === 'boolean' ? source.autostart : false,
        seedEnv: source && typeof source.seedEnv === 'boolean' ? source.seedEnv : true,
        providers: arr(source && source.providers).map(str).filter(Boolean),
        bundles: arr(source && source.bundles).map(str).filter(Boolean).join(', '),
        defaultProvider: str(source && source.default && source.default.provider),
        defaultModel: str(source && source.default && source.default.model),
        effort: str(source && source.default && source.default.reasoningEffort),
      }
    }

    function validateInstanceDraft(draft, instances, originalId) {
      const errors = []
      const id = draft.id.trim()
      if (!id) errors.push('Profile id is required.')
      else if (!SLUG.test(id)) errors.push('Profile id must be 2–40 characters: lowercase letters, digits and hyphens.')
      else if (id !== originalId && instances.some((instance) => str(instance && instance.id) === id)) {
        errors.push(`Another instance already uses “${id}”.`)
      }
      if (!draft.label.trim()) errors.push('Label is required.')
      const port = Number(draft.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('Port must be a whole number between 1 and 65535.')
      const home = draft.home.trim()
      if (home && !home.startsWith('/') && !home.startsWith('~')) {
        errors.push('Home must be an absolute path (or start with ~), or empty to let the Host derive it.')
      }
      if (draft.defaultProvider && !draft.providers.includes(draft.defaultProvider)) {
        errors.push('The default provider must also be one of the selected providers.')
      }
      return errors
    }

    function registryFromDraft(draft) {
      const registry = {
        id: draft.id.trim(),
        label: draft.label.trim(),
        port: Number(draft.port),
        autostart: draft.autostart === true,
        seedEnv: draft.seedEnv === true,
        providers: draft.providers.slice(),
        bundles: draft.bundles.split(',').map((part) => part.trim()).filter(Boolean),
      }
      if (draft.home.trim()) registry.home = draft.home.trim()
      const def = {}
      if (draft.defaultProvider) def.provider = draft.defaultProvider
      if (draft.defaultModel.trim()) def.model = draft.defaultModel.trim()
      if (draft.effort) def.reasoningEffort = draft.effort
      registry.default = def
      return registry
    }

    function InstanceEditor({ source, defaults, instances, providers, onClose, onSubmit, saving }) {
      const [draft, setDraft] = useState(() => makeInstanceDraft(source, defaults, instances, source === null || source.fresh === true))
      const patch = (changes) => setDraft((current) => ({ ...current, ...changes }))

      const originalId = source && source.fresh !== true ? str(source.id) : ''
      const errors = validateInstanceDraft(draft, instances, originalId)

      const selectedProviders = draft.providers
        .map((name) => providers.find((provider) => str(provider && provider.name) === name))
        .filter(Boolean)
      const defaultProviderOptions = [{ value: '', label: 'No default provider' }]
        .concat(selectedProviders.map((provider) => ({
          value: str(provider.name),
          label: str(provider.label) || str(provider.name),
        })))
      if (draft.defaultProvider && !selectedProviders.some((provider) => str(provider.name) === draft.defaultProvider)) {
        defaultProviderOptions.push({ value: draft.defaultProvider, label: `${draft.defaultProvider} (not selected)` })
      }

      const chosen = providers.find((provider) => str(provider && provider.name) === draft.defaultProvider) || null
      const modelIds = arr(chosen && chosen.models).map((model) => str(model && model.id)).filter(Boolean)
      const modelOptions = [{ value: '', label: 'No default model' }]
        .concat(modelIds.map((id) => ({ value: id, label: id })))
      if (draft.defaultModel && !modelIds.includes(draft.defaultModel)) {
        modelOptions.push({ value: draft.defaultModel, label: `${draft.defaultModel} (typed)` })
      }

      const effortOptions = [{ value: '', label: 'Not set' }]
        .concat(EFFORTS.map((value) => ({ value, label: value })))
      if (draft.effort && !EFFORTS.includes(draft.effort)) {
        effortOptions.push({ value: draft.effort, label: `${draft.effort} (from the Host)` })
      }

      const live = source && source.fresh !== true ? source : null
      return h(Drawer, {
        title: live ? `Edit instance: ${str(live.label) || str(live.id)}` : 'New instance',
        subtitle: live ? `${str(live.id)} · ${str(live.status) || 'status unknown'}` : 'a second DSH host on its own home and port',
        onClose,
        footer: [
          h('button', {
            key: 'save', className: 'fl-btn fl-btn-brand', disabled: errors.length > 0 || saving === true,
            onClick: () => onSubmit(registryFromDraft(draft)),
          }, saving === true ? 'Saving…' : 'Save'),
          h('button', { key: 'cancel', className: 'fl-btn', onClick: onClose }, 'Cancel'),
          errors.length ? h('div', { key: 'n', className: 'fl-line-error' }, `${errors.length} field(s) need attention`) : null,
        ],
      },
        live ? h('div', { className: 'fl-kv' },
          h('div', null, `Status: ${str(live.status) || 'unknown'}${live.pid ? ` · pid ${str(live.pid)}` : ''}`),
          // `urlBase` is the token-free address; the tokenized `url` is only ever
          // handed to the open call, never printed here.
          h('div', { className: 'fl-mono' }, str(live.urlBase) || str(live.url) || 'No address captured yet — start the instance to get one.'),
          live.portBusy === true ? h('div', { className: 'fl-line-warn' }, `Port ${str(live.port) || 'the assigned port'} is busy on this host.`) : null,
          h('div', null, live.provisioned === false ? 'Not provisioned yet: saving only writes the registry.' : ''),
          live.stale === true ? h('div', { className: 'fl-line-warn' }, 'Stale: the registry was edited after this profile was provisioned. Re-provision to apply it.') : null,
          str(live.lastError) ? h('div', { className: 'fl-line-error' }, `Last error: ${str(live.lastError)}`) : null) : null,

        h('div', { className: 'fl-note' },
          'Saving replaces the whole fleet registry. A provisioned instance keeps its old profile until it is re-provisioned, then restarted.'),

        h('div', { className: 'fl-grid' },
          h(Field, { label: 'Label', children: h(TextInput, { value: draft.label, onChange: (value) => patch({ label: value }), placeholder: 'GPU box' }) }),
          h(Field, {
            label: 'Profile id',
            hint: 'Slug: 2–40 characters, lowercase letters, digits and hyphens. It names the profile and the log file.',
            children: h(TextInput, { value: draft.id, onChange: (value) => patch({ id: value }), mono: true, placeholder: 'gpu-a' }),
          }),
          h(Field, {
            label: 'Port',
            hint: str(defaults && defaults.portBase) !== ''
              ? `The Host base port is ${str(defaults.portBase)}; each instance gets base + index.`
              : 'The Host reported no base port, so 3101 is suggested here.',
            children: h(TextInput, { value: draft.port, onChange: (value) => patch({ port: value }), mono: true }),
          }),
          h(Field, {
            label: 'DSH home',
            hint: str(defaults && defaults.homeRoot) !== ''
              ? `Absolute path. Empty means ${str(defaults.homeRoot)}/<profile id>.`
              : 'Absolute path. Leave empty and the Host derives it from its own home root.',
            children: h(TextInput, { value: draft.home, onChange: (value) => patch({ home: value }), mono: true, placeholder: '/Users/you/.dsh-fleet/gpu-a' }),
          })),

        h('div', { className: 'fl-grid' },
          h(Checkbox, {
            checked: draft.autostart, onChange: (value) => patch({ autostart: value }),
            label: 'Autostart', hint: 'Started with the fleet plugin, and restarted after a re-provision.',
          }),
          h(Checkbox, {
            checked: draft.seedEnv, onChange: (value) => patch({ seedEnv: value }),
            label: 'Seed env', hint: 'Copy .env and .credentials.yaml from this home into the instance home. Off means isolated credentials.',
          })),

        h(Field, {
          label: 'Providers for this instance',
          hint: providers.length
            ? 'Every selected provider is written into the instance profile, so all of them are pickable there.'
            : 'No providers are defined yet. Add one in the Providers panel.',
          children: providers.length
            ? h('div', { className: 'fl-list' }, ...providers.map((provider) => {
              const name = str(provider && provider.name)
              return h(Checkbox, {
                key: name,
                checked: draft.providers.includes(name),
                label: str(provider.label) || name,
                hint: [str(provider.api), str(provider.baseURL)].filter(Boolean).join(' · '),
                onChange: (checked) => patch({
                  providers: checked ? draft.providers.concat([name]) : draft.providers.filter((item) => item !== name),
                }),
              })
            }))
            : h('div', { className: 'fl-empty' }, 'No providers yet.'),
        }),

        h('div', { className: 'fl-grid' },
          h(Field, {
            label: 'Default provider',
            children: h(Select, {
              value: draft.defaultProvider,
              onChange: (value) => patch({ defaultProvider: value, defaultModel: '' }),
              options: defaultProviderOptions,
            }),
          }),
          h(Field, {
            label: 'Default model',
            hint: modelIds.length
              ? 'Pick one reported by that provider, or type any model id in the box below.'
              : 'This provider reports no models — type the model id.',
            children: [
              h(Select, {
                key: 'pick', value: draft.defaultModel && modelIds.includes(draft.defaultModel) ? draft.defaultModel : (draft.defaultModel ? '__typed__' : ''),
                disabled: modelIds.length === 0,
                onChange: (value) => {
                  if (value !== '' && value !== '__typed__') patch({ defaultModel: value })
                },
                options: modelOptions.concat(draft.defaultModel && !modelIds.includes(draft.defaultModel) ? [] : [{ value: '__typed__', label: 'Custom model id…' }]),
              }),
              h(TextInput, {
                key: 'text', value: draft.defaultModel, mono: true, placeholder: 'model id',
                onChange: (value) => patch({ defaultModel: value }),
              }),
            ],
          }),
          h(Field, {
            label: 'Reasoning effort',
            hint: 'Written to the instance profile as its default thinking budget.',
            children: h(Select, { value: draft.effort, onChange: (value) => patch({ effort: value }), options: effortOptions }),
          })),

        h(Field, {
          label: 'Bundles',
          hint: 'Comma-separated bundle names layered onto this instance. Leave empty for the standard web profile.',
          children: h(TextInput, { value: draft.bundles, onChange: (value) => patch({ bundles: value }), placeholder: 'dsh-fleet, my-extras' }),
        }),

        errors.length ? h('div', { className: 'fl-err' }, ...errors.map((error, index) => h('div', { key: index }, error))) : null,
      )
    }

    // ---------- provider editor ----------
    function modelsToText(models) {
      return arr(models).map((model) => {
        const contextWindow = asNumber(model && model.contextWindow)
        const maxTokens = asNumber(model && model.maxTokens)
        const parts = [str(model && model.id), contextWindow === null ? '' : String(contextWindow)]
        if (maxTokens !== null) parts.push(String(maxTokens))
        return parts.join(' | ')
      }).join('\n')
    }

    function parseModelsText(text) {
      const models = []
      const issues = []
      String(text || '').split('\n').forEach((line, index) => {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) return
        const parts = trimmed.split('|').map((part) => part.trim())
        if (!parts[0]) {
          issues.push(`Line ${index + 1}: no model id before the first “|”.`)
          return
        }
        const model = { id: parts[0] }
        if (parts[1]) {
          const value = Number(parts[1])
          if (!Number.isInteger(value) || value <= 0) issues.push(`Line ${index + 1}: context window “${parts[1]}” is not a whole number.`)
          else model.contextWindow = value
        }
        if (parts[2]) {
          const value = Number(parts[2])
          if (!Number.isInteger(value) || value <= 0) issues.push(`Line ${index + 1}: max tokens “${parts[2]}” is not a whole number.`)
          else model.maxTokens = value
        }
        if (parts.length > 3 && parts[3]) issues.push(`Line ${index + 1}: “${parts[3]}” is beyond max tokens and was ignored.`)
        models.push(model)
      })
      return { models, issues }
    }

    function makeProviderDraft(source, providers) {
      const name = source ? str(source.name) : ''
      return {
        name: name || `provider-${providers.length + 1}`,
        label: source ? str(source.label) : '',
        api: source && str(source.api) ? str(source.api) : 'openai-completions',
        baseURL: source ? str(source.baseURL) : '',
        apiKey: source ? str(source.apiKey) : '',
        apiKeyRef: source ? str(source.apiKeyRef) : '',
        modelsText: modelsToText(source && source.models),
      }
    }

    function validateProviderDraft(draft, providers, originalName) {
      const errors = []
      const name = draft.name.trim()
      if (!name) errors.push('Provider name is required.')
      else if (!SLUG.test(name)) errors.push('Provider name must be 2–40 characters: lowercase letters, digits and hyphens.')
      else if (name !== originalName && providers.some((provider) => str(provider && provider.name) === name)) {
        errors.push(`Another provider already uses “${name}”.`)
      }
      if (!draft.api) errors.push('Pick the API kind the endpoint speaks.')
      const base = draft.baseURL.trim()
      if (!base) errors.push('Base URL is required.')
      else if (!/^https?:\/\//i.test(base)) errors.push('Base URL must start with http:// or https://.')
      return errors
    }

    function ProviderEditor({ source, providers, onClose, onSubmit, saving }) {
      const [draft, setDraft] = useState(() => makeProviderDraft(source, providers))
      const [testNote, setTestNote] = useState([])
      const [testing, setTesting] = useState(false)
      const controllerRef = useRef(null)
      const patch = (changes) => setDraft((current) => ({ ...current, ...changes }))

      useEffect(() => {
        const controller = new AbortController()
        controllerRef.current = controller
        return () => {
          controller.abort()
          controllerRef.current = null
        }
      }, [])

      const originalName = source && source.fresh !== true ? str(source.name) : ''
      const errors = validateProviderDraft(draft, providers, originalName)
      const parsed = parseModelsText(draft.modelsText)
      const apiOptions = API_KINDS.map((value) => ({ value, label: value }))
      if (draft.api && !API_KINDS.includes(draft.api)) apiOptions.push({ value: draft.api, label: `${draft.api} (from the Host)` })

      const test = async () => {
        if (errors.length) return
        setTesting(true)
        setTestNote([`Probing ${draft.baseURL.trim()} …`])
        const body = { baseURL: draft.baseURL.trim() }
        if (draft.apiKey.trim()) body.apiKey = draft.apiKey.trim()
        if (draft.apiKeyRef.trim()) body.apiKeyRef = draft.apiKeyRef.trim()
        // The page contract names the engine `vendor`; FLEET-PLAN §3 names it `api`.
        // Both keys are sent so either Host build answers; see the report note.
        body.vendor = draft.api
        body.api = draft.api
        const result = await requestJson({ method: 'POST', path: ROUTES.probe, body, signal: controllerRef.current ? controllerRef.current.signal : undefined })
        setTesting(false)
        if (result.aborted) {
          setTestNote(['Probe aborted.'])
          return
        }
        if (!result.ok) {
          setTestNote([`Endpoint test failed: ${result.error}`])
          return
        }
        const reported = arr(result.data && result.data.models).map(projectModel).filter((model) => model.id)
        if (!reported.length) {
          setTestNote(['Endpoint answered, but reported no models.'])
          return
        }
        const current = parseModelsText(draft.modelsText)
        const previous = new Map(current.models.map((model) => [model.id, model]))
        const merged = reported.map((model) => {
          const kept = previous.get(model.id)
          if (!kept) return model
          const next = { ...model }
          if (next.maxTokens === undefined && kept.maxTokens !== undefined) next.maxTokens = kept.maxTokens
          if (next.contextWindow === undefined && kept.contextWindow !== undefined) next.contextWindow = kept.contextWindow
          return next
        })
        const held = current.models.filter((model) => !reported.some((entry) => entry.id === model.id))
        setDraft((state) => ({ ...state, modelsText: modelsToText(merged.concat(held)) }))
        setTestNote([
          `Endpoint test OK: ${merged.length} model${merged.length === 1 ? '' : 's'} read from the endpoint and written into the list.`,
          held.length ? `${held.length} local line${held.length === 1 ? '' : 's'} kept because the endpoint did not report them.` : '',
        ].filter(Boolean))
      }

      const submit = () => {
        // Keep the whole Host-side model object keyed by id so fields this page
        // cannot author (`input`) survive a hand-edited provider. They are
        // re-attached only when the Host actually reported them, so a field that
        // was absent stays absent instead of being invented here.
        const originals = new Map(arr(source && source.models).map((model) => [str(model && model.id), model]))
        const registry = {
          name: draft.name.trim(),
          api: draft.api,
          baseURL: draft.baseURL.trim(),
          models: parsed.models.map((model) => {
            const out = { ...model }
            const kept = originals.get(model.id)
            const keptName = str(kept && kept.name)
            if (keptName) out.name = keptName
            if (Array.isArray(kept && kept.input)) out.input = arr(kept.input).map(str).filter(Boolean)
            return out
          }),
        }
        if (draft.label.trim()) registry.label = draft.label.trim()
        if (draft.apiKey.trim()) registry.apiKey = draft.apiKey.trim()
        if (draft.apiKeyRef.trim()) registry.apiKeyRef = draft.apiKeyRef.trim()
        onSubmit(registry)
      }

      return h(Drawer, {
        title: source && source.fresh !== true ? `Edit provider: ${str(source.name)}` : 'New provider',
        subtitle: 'shared catalog: every instance can be given all of these',
        onClose,
        footer: [
          h('button', {
            key: 'save', className: 'fl-btn fl-btn-brand',
            disabled: errors.length > 0 || parsed.issues.length > 0 || saving === true,
            onClick: submit,
          }, saving === true ? 'Saving…' : 'Save'),
          h('button', {
            key: 'test', className: 'fl-btn', disabled: errors.length > 0 || testing === true,
            onClick: () => { void test() },
          }, testing === true ? 'Testing…' : 'Test endpoint'),
          h('button', { key: 'cancel', className: 'fl-btn', onClick: onClose }, 'Cancel'),
        ],
      },
        source && source.fresh !== true
          ? h('div', { className: 'fl-note' }, 'Changing a provider changes what re-provisioning writes into every instance profile that selects it.')
          : null,

        h('div', { className: 'fl-grid' },
          h(Field, {
            label: 'Provider name',
            hint: 'Slug. It is the key in the instance profile, so instances refer to it by this name.',
            children: h(TextInput, { value: draft.name, onChange: (value) => patch({ name: value }), mono: true, placeholder: 'gpu-a-box' }),
          }),
          h(Field, {
            label: 'Display label',
            hint: 'Shown in pickers. Falls back to the name when empty.',
            children: h(TextInput, { value: draft.label, onChange: (value) => patch({ label: value }), placeholder: 'GPU box A' }),
          }),
          h(Field, {
            label: 'API kind',
            hint: 'Decides how the Host talks to the endpoint and which path a probe reads.',
            children: h(Select, { value: draft.api, onChange: (value) => patch({ api: value }), options: apiOptions }),
          })),

        h(Field, {
          label: 'Base URL',
          hint: 'Origin of the endpoint, including any /v1 suffix used by that box.',
          children: h(TextInput, { value: draft.baseURL, onChange: (value) => patch({ baseURL: value }), mono: true, placeholder: 'http://192.168.1.20:1234/v1' }),
        }),

        source && source.fresh !== true
          ? h('div', { className: 'fl-kv' },
            h('div', null, `Key on the Host: ${source.hasKey === true
              ? (str(source.apiKeyRef) ? `read from ${str(source.apiKeyRef)}` : 'a stored value, whose text is never sent to this page')
              : 'none configured'}.`))
          : null,

        h('div', { className: 'fl-grid' },
          h(Field, {
            label: 'API key',
            hint: 'Leave empty to keep whatever the Host already stores: the stored value is never sent back to this page, and an empty field does not clear it. A key typed here replaces it and is written into the fleet registry in plain text, in your own profile patch.',
            children: h(TextInput, { value: draft.apiKey, onChange: (value) => patch({ apiKey: value }), type: 'password', mono: true }),
          }),
          h(Field, {
            label: 'API key reference',
            hint: 'Name of an env var or credential record to read instead of a stored value.',
            children: h(TextInput, { value: draft.apiKeyRef, onChange: (value) => patch({ apiKeyRef: value }), mono: true, placeholder: 'DEEPSEEK_API_KEY' }),
          })),

        h(Field, {
          label: 'Models',
          hint: 'One per line: id | contextWindow | maxTokens. Blank lines and lines starting with # are ignored.',
          children: h('textarea', {
            className: 'fl-textarea', value: draft.modelsText, spellcheck: false,
            placeholder: 'deepseek-chat | 65536 | 8192',
            onChange: (event) => patch({ modelsText: event.target.value }),
          }),
        }),
        parsed.issues.length ? h('div', { className: 'fl-err' }, ...parsed.issues.map((issue, index) => h('div', { key: index }, issue))) : null,
        testNote.length ? h('div', { className: parsed.issues.length ? 'fl-warn' : 'fl-ok' }, ...testNote.map((line, index) => h('div', { key: index }, line))) : null,
        h('div', { className: 'fl-sub' }, `${parsed.models.length} model line${parsed.models.length === 1 ? '' : 's'} parsed from the text box.`),
        errors.length ? h('div', { className: 'fl-err' }, ...errors.map((error, index) => h('div', { key: index }, error))) : null,
      )
    }

    // ---------- logs ----------
    function LogsEditor({ instance, onClose }) {
      const [lines, setLines] = useState(null)
      const [error, setError] = useState('')
      const [path, setPath] = useState('')
      const [nonce, setNonce] = useState(0)
      const boxRef = useRef(null)
      const id = str(instance && instance.id)

      useEffect(() => {
        const controller = new AbortController()
        let alive = true
        const load = async () => {
          const result = await requestJson({ path: `${ROUTES.logs}?id=${encodeURIComponent(id)}`, signal: controller.signal })
          if (!alive || result.aborted) return
          if (!result.ok) {
            setError(result.error)
            return
          }
          setError('')
          setPath(str(result.data && result.data.path))
          setLines(arr(result.data && result.data.lines).map(str))
        }
        void load()
        const timer = setInterval(() => { void load() }, LOGS_MS)
        return () => {
          alive = false
          clearInterval(timer)
          controller.abort()
        }
      }, [id, nonce])

      useEffect(() => {
        const box = boxRef.current
        if (box) box.scrollTop = box.scrollHeight
      }, [lines])

      return h(Drawer, {
        title: `Logs: ${str(instance.label) || id}`,
        subtitle: path || 'no log path reported',
        onClose,
        footer: [
          h('button', { key: 'r', className: 'fl-btn', onClick: () => setNonce((value) => value + 1) }, 'Refresh'),
          h('div', { key: 's', className: 'fl-spacer' }),
          h('div', { key: 'n', className: 'fl-sub' }, lines === null ? 'Loading…' : `${lines.length} line${lines.length === 1 ? '' : 's'} · refreshes every ${LOGS_MS / 1000} s`),
        ],
      },
        error ? h('div', { className: 'fl-err' }, error) : null,
        error ? null : h('div', { className: 'fl-logbox', ref: boxRef },
          lines === null ? 'Loading…' : lines.length ? lines.join('\n') : 'The log file is empty so far.'),
      )
    }

    // ---------- page ----------
    function Page() {
      const { data, error, loading, fetchedAt } = useFleetStore('page')
      const [busy, setBusy] = useState({})
      const [flash, setFlash] = useState(null)
      const [savedWarnings, setSavedWarnings] = useState([])
      const [drawer, setDrawer] = useState(null)
      const [saving, setSaving] = useState(false)
      const [installing, setInstalling] = useState(false)
      const [installReport, setInstallReport] = useState(null)
      const flashTimer = useRef(0)
      const pageController = useRef(null)

      useEffect(() => {
        const controller = new AbortController()
        pageController.current = controller
        return () => {
          controller.abort()
          pageController.current = null
          if (flashTimer.current) {
            clearTimeout(flashTimer.current)
            flashTimer.current = 0
          }
        }
      }, [])

      const showFlash = useCallback((tone, text) => {
        setFlash({ tone, text })
        if (flashTimer.current) clearTimeout(flashTimer.current)
        flashTimer.current = setTimeout(() => {
          flashTimer.current = 0
          setFlash(null)
        }, 8000)
      }, [])

      const signal = () => (pageController.current ? pageController.current.signal : undefined)
      const closeDrawer = useCallback(() => setDrawer(null), [])
      const markBusy = (key, value) => setBusy((current) => {
        const next = { ...current }
        if (value) next[key] = true
        else delete next[key]
        return next
      })

      const instances = arr(data && data.instances)
      const providers = arr(data && data.providers)
      const launcher = obj(data && data.launcher)
      const defaults = obj(data && data.defaults) || {}
      const hostWarnings = arr(data && data.warnings).map(str).filter(Boolean)

      const callAction = async (action, id, key) => {
        markBusy(key, true)
        const result = await requestJson({ method: 'POST', path: ROUTES.action, body: { action, id }, signal: signal() })
        markBusy(key, false)
        if (result.aborted) return
        if (!result.ok) {
          showFlash('error', `${action} on ${id} failed: ${result.error}`)
          return
        }
        const updated = obj(result.data && result.data.instance)
        const suffix = updated && str(updated.status) ? ` (${str(updated.status)})` : ''
        showFlash('ok', `${action} accepted for ${id}${suffix}.`)
        void refresh()
      }

      // The launcher-drift remedy: the Host installs the dsh build matching this
      // Host's version and re-probes the launcher, so the page re-reads state.
      const installRuntime = async () => {
        setInstalling(true)
        setInstallReport(null)
        const result = await requestJson({ method: 'POST', path: ROUTES.install, signal: signal() })
        setInstalling(false)
        if (result.aborted) return
        if (!result.ok) {
          setInstallReport({ error: result.error, output: '', exit: null })
          showFlash('error', `CLI install request failed: ${result.error}`)
          void refresh()
          return
        }
        const raw = result.data && result.data.output
        const output = Array.isArray(raw) ? arr(raw).map(str).join('\n') : str(raw)
        const exit = asNumber(result.data && result.data.exit)
        setInstallReport({ error: '', output, exit })
        showFlash(exit === 0 || exit === null ? 'ok' : 'error', exit === null
          ? 'CLI install finished; the launcher status was re-read.'
          : exit === 0
            ? 'CLI install finished with exit 0; the launcher status was re-read.'
            : `The installer exited with code ${exit}; the launcher status was re-read.`)
        void refresh()
      }

      const saveRegistry = async (nextInstances, nextProviders) => {
        setSaving(true)
        const result = await requestJson({ method: 'POST', path: ROUTES.save, body: { instances: nextInstances, providers: nextProviders }, signal: signal() })
        setSaving(false)
        if (result.aborted) return
        if (!result.ok) {
          showFlash('error', `Save failed: ${result.error}`)
          return
        }
        setSavedWarnings(arr(result.data && result.data.warnings).map(str).filter(Boolean))
        const savedInstances = Array.isArray(result.data && result.data.instances) ? result.data.instances : null
        const savedProviders = Array.isArray(result.data && result.data.providers) ? result.data.providers : null
        showFlash('ok', savedInstances && savedProviders
          ? `Saved: ${savedInstances.length} instances and ${savedProviders.length} providers.`
          : 'Saved the fleet registry.')
        setDrawer(null)
        void refresh()
      }

      const saveInstance = async (registry) => {
        // A duplicated row keeps its source: only an in-place edit replaces it.
        const editingId = drawer && drawer.kind === 'instance' && !drawer.fresh ? drawer.id : null
        const next = instances
          .filter((instance) => (editingId ? str(instance && instance.id) !== editingId : true))
          .map(projectInstance)
          .concat([registry])
        await saveRegistry(next, providers.map(projectProvider))
      }

      const saveProvider = async (registry) => {
        const editingName = drawer && drawer.kind === 'provider' ? drawer.name : null
        const next = providers
          .filter((provider) => (editingName ? str(provider && provider.name) !== editingName : true))
          .map(projectProvider)
          .concat([registry])
        const touched = instances.filter((instance) => {
          const usesDefault = str(instance && instance.default && instance.default.provider) === registry.name
          const lists = arr(instance && instance.providers).some((name) => str(name) === registry.name)
          return usesDefault || lists
        })
        await saveRegistry(instances.map(projectInstance), next)
        if (touched.length) {
          showFlash('ok', `Re-provision ${touched.map((instance) => str(instance.id)).join(', ')} to push this provider into those profiles.`)
        }
      }

      const removeRow = async (kind, id) => {
        const what = kind === 'instance' ? 'instance' : 'provider'
        const detail = kind === 'instance'
          ? `Forget the ${what} “${id}”? It is removed from the fleet registry; its DSH home and log file stay on disk.`
          : `Delete the ${what} “${id}”? Instances that default to it will need a new default on the next provision.`
        if (!window.confirm(detail)) return
        const key = `delete:${id}`
        markBusy(key, true)
        const result = await requestJson({ method: 'POST', path: ROUTES.del, body: { kind, id }, signal: signal() })
        markBusy(key, false)
        if (result.aborted) return
        if (!result.ok) {
          showFlash('error', `Delete failed: ${result.error}`)
          return
        }
        showFlash('ok', `Removed ${what} ${id}.`)
        if (drawer && (drawer.id === id || drawer.name === id)) setDrawer(null)
        void refresh()
      }

      const toggleAutostart = async (instance, value) => {
        const id = str(instance && instance.id)
        const key = `autostart:${id}`
        markBusy(key, true)
        const next = instances.map((row) => {
          const registry = projectInstance(row)
          if (str(row && row.id) === id) registry.autostart = value
          return registry
        })
        await saveRegistry(next, providers.map(projectProvider))
        markBusy(key, false)
      }

      // Open asks the Host first: it owns the token that mints a session cookie.
      // A response carrying a url is opened here; a response without one means the
      // Host opened the window itself (Chrome app window), and an error such as
      // "not running" is shown as a red line.
      const openInstance = async (instance) => {
        const id = str(instance && instance.id)
        const key = `open:${id}`
        markBusy(key, true)
        const result = await requestJson({ method: 'POST', path: ROUTES.open, body: { id }, signal: signal() })
        markBusy(key, false)
        if (result.aborted) return
        if (!result.ok) {
          showFlash('error', `Open failed for ${id}: ${result.error}`)
          return
        }
        const warnings = arr(result.data && result.data.warnings).map(str).filter(Boolean)
        const url = str(result.data && result.data.url) || str(instance && instance.url)
        if (!url) {
          const mode = str(result.data && result.data.openMode)
          showFlash('ok', [`The Host opened this instance itself${mode ? ` in ${mode} mode` : ''}.`].concat(warnings).join(' '))
          return
        }
        if (!/^https?:\/\//i.test(url)) {
          showFlash('error', `Refusing to open a non-http URL: ${url}`)
          return
        }
        window.open(url, '_blank', 'noopener')
        if (warnings.length) showFlash('ok', warnings.join(' '))
      }

      // ----- drawer target resolution -----
      const drawerNode = (() => {
        if (!drawer) return null
        if (drawer.kind === 'logs') {
          const instance = instances.find((row) => str(row && row.id) === drawer.id)
          return instance
            ? h(LogsEditor, { key: `logs:${drawer.id}`, instance, onClose: closeDrawer })
            : h(Drawer, { title: 'Logs', onClose: closeDrawer }, h('div', { className: 'fl-empty' }, 'This instance is no longer in the registry.'))
        }
        if (drawer.kind === 'instance') {
          const source = drawer.id ? instances.find((row) => str(row && row.id) === drawer.id) : null
          if (drawer.id && !source) {
            return h(Drawer, { title: 'Edit instance', onClose: closeDrawer },
              h('div', { className: 'fl-empty' }, 'This instance is no longer in the registry — refresh the page.'))
          }
          const seed = source ? (drawer.fresh ? { ...source, fresh: true } : source) : { fresh: true }
          return h(InstanceEditor, {
            key: `instance:${drawer.id || 'new'}:${drawer.fresh ? 'fresh' : 'edit'}`,
            source: seed,
            defaults,
            instances,
            providers,
            saving,
            onClose: closeDrawer,
            onSubmit: (registry) => { void saveInstance(registry) },
          })
        }
        if (drawer.kind === 'provider') {
          const source = drawer.name ? providers.find((row) => str(row && row.name) === drawer.name) : null
          if (drawer.name && !source) {
            return h(Drawer, { title: 'Edit provider', onClose: closeDrawer },
              h('div', { className: 'fl-empty' }, 'This provider is no longer in the registry — refresh the page.'))
          }
          return h(ProviderEditor, {
            key: `provider:${drawer.name || 'new'}`,
            source: source || { fresh: true },
            providers,
            saving,
            onClose: closeDrawer,
            onSubmit: (registry) => { void saveProvider(registry) },
          })
        }
        return null
      })()

      const launcherVersion = str(launcher && launcher.version)
      const hostStamp = toMillis(data && data.generatedAt)
      const stateStamp = hostStamp || fetchedAt
      const launcherWanted = str(launcher && launcher.wanted)
      const launcherPath = str(launcher && launcher.path)
      const versionMismatch = launcherWanted !== '' && launcherVersion !== '' && launcherVersion !== launcherWanted

      const launcherLine = launcher
        ? [launcherPath || 'launcher path not reported', launcherVersion ? `v${launcherVersion}` : 'version unknown'].join(' · ')
        : 'Launcher status not reported by the Host.'
      const runningCount = instances.filter((instance) => str(instance && instance.status) === 'running').length

      return h('div', { className: 'fl-root' },
        h('style', null, CSS),

        h('div', { className: 'fl-head' },
          h('div', { className: 'fl-title' }, 'Fleet'),
          h('div', { className: 'fl-sub', title: launcherLine },
            launcherLine,
            versionMismatch ? ` · Host wants v${launcherWanted}` : ''),
          h('div', { className: 'fl-sub' }, `${runningCount}/${instances.length} running`),
          h('div', { className: 'fl-spacer' }),
          fetchedAt ? h('div', { className: 'fl-sub' }, `state ${fmtClock(stateStamp)}${loading ? ' · refreshing' : ''}`) : null,
          h('button', {
            className: 'fl-btn', onClick: () => { void refresh() },
            title: `Polls every ${PAGE_MS / 1000} s while this page is visible.`,
          }, loading ? 'Refreshing…' : 'Refresh')),

        launcher && launcher.ok === false
          ? h('div', { className: 'fl-err' },
            h('div', null, str(launcher.reason) || 'The fleet launcher is not ready, so instances cannot be started.'),
            str(launcher.installHint) ? h('div', { className: 'fl-mono' }, str(launcher.installHint)) : null,
            h('div', { className: 'fl-actions' },
              h('button', {
                className: 'fl-btn fl-btn-sm fl-btn-brand',
                disabled: installing === true,
                title: 'Ask the Host to install the dsh build that matches this Host, then re-read the launcher.',
                onClick: () => { void installRuntime() },
              }, installing === true ? 'Installing…' : 'Install matching CLI')),
            installReport && installReport.error ? h('div', null, installReport.error) : null,
            installReport && installReport.exit !== null ? h('div', null, `Installer exit code ${installReport.exit}.`) : null,
            installReport && installReport.output ? h('div', { className: 'fl-logbox fl-output' }, installReport.output) : null)
          : null,

        versionMismatch && !(launcher && launcher.ok === false)
          ? h('div', { className: 'fl-warn' },
            h('div', null, `Version drift: the launcher is v${launcherVersion}, this Host is v${launcherWanted}. Instances started by a different build can behave unexpectedly.`),
            str(launcher && launcher.installHint) ? h('div', { className: 'fl-mono' }, str(launcher.installHint)) : null)
          : null,

        error ? h('div', { className: 'fl-err' }, h('div', null, 'Fleet state could not be read.'), h('div', null, error)) : null,

        flash
          ? h('div', { className: flash.tone === 'error' ? 'fl-err' : 'fl-ok' }, flash.text)
          : null,

        hostWarnings.length || savedWarnings.length
          ? h('div', { className: 'fl-warn' },
            h('div', null, hostWarnings.length ? 'Host warnings' : 'Last save reported warnings'),
            ...hostWarnings.concat(savedWarnings).map((line, index) => h('div', { key: `${index}-${line}` }, line)))
          : null,

        data === null && fetchedAt === 0 && !error
          ? h('div', { className: 'fl-note' }, 'Waiting for the first fleet state read. If nothing appears, the Host half of this bundle is not serving /fleet/api/state yet.')
          : null,

        // ----- instances -----
        h('div', { className: 'fl-panel' },
          h('div', { className: 'fl-panel-head' }, 'Instances',
            h('div', { className: 'fl-sub' },
              str(defaults.homeRoot) || str(defaults.portBase) !== ''
                ? `homes ${str(defaults.homeRoot) || 'not reported'} · ports from ${str(defaults.portBase) || 'not reported'}`
                : 'the Host reported no defaults'),
            h('div', { className: 'fl-spacer' }),
            h('button', {
              className: 'fl-btn fl-btn-brand', onClick: () => setDrawer({ kind: 'instance', id: null }),
              title: 'Add a row to the registry. It needs provisioning before it can start.',
            }, 'Add instance')),
          instances.length
            ? h('table', { className: 'fl-table' },
              h('thead', null, h('tr', null,
                h('th', null, 'Instance'), h('th', null, 'Profile'), h('th', null, 'Port'),
                h('th', null, 'Default'), h('th', null, 'Status'), h('th', null, 'Pid'),
                h('th', null, 'Uptime'), h('th', null, 'Autostart'), h('th', null, 'Actions'))),
              h('tbody', null, instances.map((instance, index) => {
                const id = str(instance && instance.id) || `row-${index}`
                const status = str(instance && instance.status)
                const url = str(instance && instance.url)
                const urlBase = str(instance && instance.urlBase)
                const pid = str(instance && instance.pid)
                const def = obj(instance && instance.default) || {}
                const stale = instance && instance.stale === true
                const provisioned = instance && instance.provisioned === true
                const defaultText = str(def.provider) || str(def.model)
                  ? [str(def.provider) || 'no provider', str(def.model) || 'no model'].join(' / ')
                  : 'not set'
                const effort = str(def.reasoningEffort)
                const busyRow = Object.keys(busy).some((key) => key.endsWith(`:${id}`))
                return h('tr', { key: id },
                  h('td', null,
                    h('div', { className: 'fl-label' }, str(instance.label) || id),
                    urlBase
                      ? /^https?:\/\//i.test(urlBase)
                        ? h('a', {
                          className: 'fl-mono fl-link', href: urlBase, target: '_blank', rel: 'noopener noreferrer',
                          title: 'Token-free address. Use Open to reach the signed URL that can start a session.',
                        }, urlBase)
                        : h('div', { className: 'fl-mono' }, urlBase)
                      : null,
                    str(instance.lastError) ? h('div', { className: 'fl-line-error' }, str(instance.lastError)) : null,
                    stale ? h('div', { className: 'fl-line-warn' }, 'Stale: registry edited after provisioning.') : null),
                  h('td', { className: 'fl-mono fl-muted' }, id),
                  h('td', { className: 'fl-num' }, str(instance.port) || '—'),
                  h('td', null,
                    h('div', { title: `${defaultText}${effort ? ` · effort ${effort}` : ''}` }, defaultText),
                    effort ? h('div', { className: 'fl-muted' }, `effort ${effort}`) : null),
                  h('td', null,
                    h(StatusPill, {
                      instance,
                      busy: busy[`probe-instance:${id}`] === true,
                      onProbe: (row) => { void callAction('probe-instance', str(row.id), `probe-instance:${id}`) },
                    }),
                    stale ? h('div', null, h('button', {
                      className: 'fl-btn fl-btn-sm fl-btn-brand',
                      title: 'Write the current registry into this instance profile again.',
                      disabled: busy[`provision:${id}`] === true,
                      onClick: () => { void callAction('provision', id, `provision:${id}`) },
                    }, 'Re-provision')) : null),
                  h('td', { className: 'fl-num fl-muted' }, pid || '—'),
                  h('td', { className: 'fl-num fl-muted' }, status === 'running' ? (fmtUptime(instance.startedAt) || 'unknown') : '—'),
                  h('td', null, h('input', {
                    type: 'checkbox',
                    className: 'fl-check-input',
                    checked: instance.autostart === true,
                    disabled: busy[`autostart:${id}`] === true || saving,
                    title: busy[`autostart:${id}`] === true ? 'Saving…' : 'Start this instance when the fleet plugin loads.',
                    onChange: (event) => { void toggleAutostart(instance, event.target.checked) },
                  }), instance.autostart === true ? null : h('div', { className: 'fl-hint' }, 'off')),
                  h('td', null, h('div', { className: 'fl-actions' },
                    h('button', {
                      className: 'fl-btn fl-btn-sm',
                      disabled: (!url && !urlBase) || busyRow,
                      title: url || urlBase
                        ? 'Ask the Host for this instance’s signed address and open it'
                        : 'No URL yet — start the instance and the Host captures its tokenized URL.',
                      onClick: () => { void openInstance(instance) },
                    }, 'Open'),
                    h('button', {
                      className: 'fl-btn fl-btn-sm',
                      disabled: status === 'running' || busyRow,
                      title: status === 'running' ? 'Already running.' : 'Start a detached Host on this row’s port and home.',
                      onClick: () => { void callAction('start', id, `start:${id}`) },
                    }, 'Start'),
                    h('button', {
                      className: 'fl-btn fl-btn-sm',
                      disabled: status !== 'running' || busyRow,
                      title: status === 'running' ? 'Stop the tracked pid and its process group.' : 'Not running.',
                      onClick: () => { void callAction('stop', id, `stop:${id}`) },
                    }, 'Stop'),
                    h('button', {
                      className: 'fl-btn fl-btn-sm',
                      disabled: status !== 'running' || busyRow,
                      title: status === 'running' ? 'Stop, then start again on the same port.' : 'Not running.',
                      onClick: () => { void callAction('restart', id, `restart:${id}`) },
                    }, 'Restart'),
                    h('button', {
                      className: 'fl-btn fl-btn-sm fl-btn-brand', disabled: busyRow,
                      title: provisioned && !stale
                        ? 'Generate this instance profile again from the current registry.'
                        : 'Generate the instance profile: port, providers and default model.',
                      onClick: () => { void callAction('provision', id, `provision:${id}`) },
                    }, 'Provision'),
                    h('button', {
                      className: 'fl-btn fl-btn-sm', disabled: busyRow,
                      title: 'Read the Host’s log file for this instance.',
                      onClick: () => setDrawer({ kind: 'logs', id }),
                    }, 'Logs'),
                    h('button', {
                      className: 'fl-btn fl-btn-sm', disabled: busyRow,
                      title: 'Edit this row in the fleet registry.',
                      onClick: () => setDrawer({ kind: 'instance', id }),
                    }, 'Edit'),
                    h('button', {
                      className: 'fl-btn fl-btn-sm', disabled: busyRow,
                      title: 'Copy this row into a new profile id, then save it.',
                      onClick: () => setDrawer({ kind: 'instance', id, fresh: true }),
                    }, 'Duplicate'),
                    h('button', {
                      className: 'fl-btn fl-btn-sm fl-btn-danger', disabled: busyRow,
                      title: 'Remove this row from the registry. Files on disk are kept.',
                      onClick: () => { void removeRow('instance', id) },
                    }, 'Delete'))))
              })))
            : h('div', { className: 'fl-empty' }, 'No instances yet. Add one and it gets its own DSH home, port and default model.')),

        // ----- providers -----
        h('div', { className: 'fl-panel' },
          h('div', { className: 'fl-panel-head' }, 'Providers',
            h('div', { className: 'fl-sub' }, 'shared catalog: every instance can see all of these, with a different default'),
            h('div', { className: 'fl-spacer' }),
            h('button', {
              className: 'fl-btn fl-btn-brand', onClick: () => setDrawer({ kind: 'provider', name: null }),
              title: 'Add an LLM box to the catalog.',
            }, 'Add provider')),
          providers.length
            ? h('table', { className: 'fl-table' },
              h('thead', null, h('tr', null,
                h('th', null, 'Provider'), h('th', null, 'API'), h('th', null, 'Base URL'),
                h('th', null, 'Key'), h('th', null, 'Models'), h('th', null, 'Used by'), h('th', null, 'Actions'))),
              h('tbody', null, providers.map((provider, index) => {
                const name = str(provider && provider.name) || `provider-${index}`
                const modelCount = arr(provider && provider.models).length
                // The Host strips `apiKey` from every response and reports `hasKey`
                // instead, so this column never reads the key value itself.
                const hasKey = provider && provider.hasKey === true
                const keyText = hasKey
                  ? (str(provider.apiKeyRef) ? `ref ${str(provider.apiKeyRef)}` : 'stored value')
                  : 'not set'
                const keyTip = !hasKey
                  ? 'No key is configured for this provider.'
                  : str(provider.apiKeyRef)
                    ? 'The Host reads the key from that reference when it writes the instance profile.'
                    : 'A key is stored in the fleet registry. The Host never sends its value to this page, so the editor keeps it as long as you leave the field empty.'
                const usedBy = instances
                  .filter((instance) => arr(instance && instance.providers).some((entry) => str(entry) === name)
                    || str(instance && instance.default && instance.default.provider) === name)
                  .map((instance) => str(instance.id) || '—')
                const busyRow = Object.keys(busy).some((key2) => key2.endsWith(`:${name}`))
                return h('tr', { key: name },
                  h('td', null,
                    h('div', { className: 'fl-label' }, str(provider.label) || name),
                    str(provider.label) ? h('div', { className: 'fl-mono fl-muted' }, name) : null),
                  h('td', { className: 'fl-muted' }, str(provider.api) || 'not reported'),
                  h('td', { className: 'fl-mono fl-muted' }, str(provider.baseURL) || '—'),
                  h('td', { className: 'fl-muted', title: keyTip }, keyText),
                  h('td', { className: 'fl-num' }, String(modelCount)),
                  h('td', { className: 'fl-muted' }, usedBy.length ? usedBy.join(', ') : 'no instance'),
                  h('td', null, h('div', { className: 'fl-actions' },
                    h('button', {
                      className: 'fl-btn fl-btn-sm', disabled: busyRow,
                      title: 'Edit this provider, its key and its model list.',
                      onClick: () => setDrawer({ kind: 'provider', name }),
                    }, 'Edit'),
                    h('button', {
                      className: 'fl-btn fl-btn-sm fl-btn-danger', disabled: busyRow,
                      title: 'Remove this provider from the catalog.',
                      onClick: () => { void removeRow('provider', name) },
                    }, 'Delete'))))
              })))
            : h('div', { className: 'fl-empty' }, 'No providers yet. Add one per LLM box so instances can pick a default model from it.')),

        drawerNode)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The sidebar row and the central panel address each other by the same id.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'fleet', order: 30, label: 'Fleet' },
          Panel,
        ))
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'fleet' },
          Page,
        ))

        // One poller for both surfaces. Its interval and the in-flight state
        // request belong to this plugin's lifetime: the cleanup below clears the
        // timer, drops the visibility listener and aborts the open fetch, so a
        // reload or HMR swap never leaves a timer behind.
        startPolling()
        if (typeof ctx.effect === 'function') ctx.effect(() => stopPolling, 'dsh-fleet: fleet state polling')
        return stopPolling
      },
    }
  },
})
