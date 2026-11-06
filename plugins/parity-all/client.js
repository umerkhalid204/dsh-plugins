/**
 * dsh-doc-project-ui — Client half.
 *
 * A "Documents" sidebar panel and central page (Bionic work-project style):
 * project documents grouped by workspace, newest first, auto-refreshed; each
 * workspace offers "Open Document session" which starts a session with the
 * Document project preset. Clicking a document copies its @-reference.
 */
window.__ModuleLoader__.load({
  id: 'dsh-bionic-parity-all',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useCallback, useRef } = React
    const h = React.createElement

    const CSS = `
    .bd-root { display:flex; flex-direction:column; gap:14px; height:100%; overflow:auto; padding:18px 20px 28px; color:var(--dsw-alias-label-primary); font-size:13px; }
    .bd-head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
    .bd-title { font-size:17px; font-weight:600; }
    .bd-sub { color:var(--dsw-alias-label-secondary); font-size:12px; }
    .bd-spacer { flex:1 1 auto; }
    .bd-btn { border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:6px; padding:5px 11px; font-size:12px; cursor:pointer; }
    .bd-btn:hover { background:var(--dsw-alias-bg-layer-2); }
    .bd-group { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:10px; overflow:hidden; }
    .bd-group-head { padding:9px 12px; border-bottom:1px solid var(--dsw-alias-border-l1); display:flex; align-items:center; gap:8px; }
    .bd-group-title { font-weight:600; font-size:13px; }
    .bd-path { color:var(--dsw-alias-label-secondary); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .bd-row { display:flex; align-items:center; gap:8px; padding:6px 12px; border-bottom:1px solid var(--dsw-alias-border-l1); cursor:pointer; }
    .bd-row:last-child { border-bottom:none; }
    .bd-row:hover { background:var(--dsw-alias-bg-layer-2); }
    .bd-ext { font-size:10px; font-weight:600; text-transform:uppercase; color:var(--dsw-alias-brand-primary); border:1px solid var(--dsw-alias-border-l2); border-radius:4px; padding:1px 5px; flex:none; }
    .bd-name { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .bd-meta { color:var(--dsw-alias-label-secondary); font-size:11px; flex:none; font-variant-numeric:tabular-nums; }
    .bd-empty { padding:12px; color:var(--dsw-alias-label-secondary); }
    .bd-error { border:1px solid var(--dsw-alias-state-error-primary); border-radius:8px; padding:10px 12px; color:var(--dsw-alias-state-error-primary); }
    .bd-copied { color:var(--dsw-alias-state-success-primary); font-size:11px; flex:none; }
  `

    const fmtSize = (bytes) => {
      if (!bytes) return ''
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
      return (bytes / 1024 / 1024).toFixed(1) + ' MB'
    }
    const fmtAgo = (ms) => {
      if (!ms) return ''
      const s = Math.max(0, (Date.now() - ms) / 1000)
      if (s < 90) return 'just now'
      if (s < 3600) return Math.round(s / 60) + ' min ago'
      if (s < 86400) return Math.round(s / 3600) + ' h ago'
      if (s < 30 * 86400) return Math.round(s / 86400) + ' d ago'
      return new Date(ms).toLocaleDateString()
    }

    function Icon() {
      return h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinejoin: 'round' },
        h('path', { d: 'M4 6a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v3' }),
        h('path', { d: 'M12 22v-7' }),
        h('path', { d: 'M9 18l3-3 3 3' }))
    }

    function Page(props) {
      const { uiWorkspace } = props
      const [state, setState] = useState({ loading: true, error: '', generatedAt: 0, workspaces: [] })
      const [copied, setCopied] = useState('')
      const alive = useRef(true)

      const load = useCallback(() => {
        const controller = new AbortController()
        fetch('/bionic-docs/api/list', { signal: controller.signal })
          .then((r) => r.json())
          .then((body) => {
            if (!alive.current) return
            if (!body || body.ok === false) throw new Error((body && body.error) || 'documents list failed')
            setState({ loading: false, error: '', generatedAt: body.generatedAt, workspaces: body.workspaces || [] })
          })
          .catch((error) => {
            if (alive.current && error.name !== 'AbortError') setState((s) => ({ ...s, loading: false, error: String(error.message || error) }))
          })
        return () => controller.abort()
      }, [])

      useEffect(() => {
        alive.current = true
        let stop = load()
        const timer = setInterval(load, 15000)
        return () => { alive.current = false; stop(); clearInterval(timer) }
      }, [load])

      const openDocs = (ws) => {
        if (!uiWorkspace) return
        uiWorkspace.openWorkspace(ws.id, undefined, { agentPreset: 'document' }).catch((error) => setState((s) => ({ ...s, error: String(error?.message || error) })))
      }
      const copyRef = (doc) => {
        const text = '@' + doc.rel
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {})
        setCopied(doc.rel)
        setTimeout(() => setCopied((c) => (c === doc.rel ? '' : c)), 1500)
      }

      return h('div', { className: 'bd-root' },
        h('style', null, CSS),
        h('div', { className: 'bd-head' },
          h('span', { className: 'bd-title' }, 'Documents'),
          h('span', { className: 'bd-sub' }, state.loading ? 'Scanning…' : state.generatedAt ? new Date(state.generatedAt).toLocaleTimeString() + ' · auto-refresh 15 s' : ''),
          h('span', { className: 'bd-spacer' }),
          h('button', { className: 'bd-btn', onClick: load }, 'Refresh')),
        state.error ? h('div', { className: 'bd-error' }, state.error) : null,
        state.workspaces.length === 0 && !state.loading
          ? h('div', { className: 'bd-empty' }, 'No document files found in your workspaces yet. Ask the agent in a Document-project session to create one.')
          : null,
        state.workspaces.map((ws) => h('div', { className: 'bd-group', key: ws.id },
          h('div', { className: 'bd-group-head' },
            h('span', { className: 'bd-group-title' }, ws.title),
            h('span', { className: 'bd-path', title: ws.path }, ws.path),
            h('span', { className: 'bd-spacer' }),
            uiWorkspace ? h('button', { className: 'bd-btn', onClick: () => openDocs(ws) }, 'Open Document session') : null),
          ws.docs.length === 0
            ? h('div', { className: 'bd-empty' }, 'No documents in this workspace yet.')
            : ws.docs.map((doc) => h('div', {
              className: 'bd-row', key: ws.id + '/' + doc.rel, title: 'Copy @' + doc.rel + ' reference',
              onClick: () => copyRef(doc) },
              h('span', { className: 'bd-ext' }, doc.ext || '?'),
              h('span', { className: 'bd-name' }, doc.name),
              copied === doc.rel ? h('span', { className: 'bd-copied' }, 'copied') : null,
              h('span', { className: 'bd-meta' }, fmtSize(doc.bytes)),
              h('span', { className: 'bd-meta' }, fmtAgo(doc.mtime))))))
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const uiWorkspace = ctx.get('uiWorkspace')
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'bionic-docs', order: 25, label: 'Documents' },
          Icon,
        ))
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'bionic-docs' },
          (props) => h(Page, { ...props, key: 'bionic-docs-page', uiWorkspace }),
        ))
      },
    }
  },
})
