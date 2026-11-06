/**
 * career-ops for DeepSeek Harness — Client half.
 *
 * A sidebar panel row plus the central Career Ops page: the applications tracker,
 * the pending evaluation queue, the funnel, and recent reports. Data comes from
 * this package's Host routes (/career-ops/api/state, /career-ops/api/status) —
 * the status control calls the same career-ops `set-status` operation the agent
 * tool calls, so there is one implementation behind both surfaces.
 */
window.__ModuleLoader__.load({
  id: 'dsh-career-ops',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    const CSS = `
.co-root { display:flex; flex-direction:column; gap:14px; height:100%; overflow:auto; padding:18px 20px 28px;
  color:var(--dsw-alias-label-primary); font-size:13px; }
.co-head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
.co-title { font-size:17px; font-weight:600; }
.co-sub { color:var(--dsw-alias-label-secondary); font-size:12px; }
.co-spacer { flex:1 1 auto; }
.co-btn { border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary); border-radius:6px; padding:5px 11px; font-size:12px; cursor:pointer; }
.co-btn:hover { background:var(--dsw-alias-bg-layer-2); }
.co-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(112px,1fr)); gap:8px; }
.co-card { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px; padding:9px 11px; display:flex; flex-direction:column; gap:3px; }
.co-card b { font-size:18px; font-weight:600; }
.co-card span { color:var(--dsw-alias-label-secondary); font-size:11px; }
.co-panel { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px; overflow:hidden; }
.co-panel-head { padding:9px 12px; border-bottom:1px solid var(--dsw-alias-border-l1);
  display:flex; align-items:center; gap:8px; font-weight:600; font-size:12.5px; }
.co-table { width:100%; border-collapse:collapse; font-size:12.5px; }
.co-table th { text-align:left; font-weight:500; color:var(--dsw-alias-label-secondary);
  padding:7px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); white-space:nowrap; }
.co-table td { padding:7px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); vertical-align:top; }
.co-table tr:last-child td { border-bottom:none; }
.co-role { font-weight:500; }
.co-muted { color:var(--dsw-alias-label-secondary); }
.co-score { font-variant-numeric:tabular-nums; font-weight:600; }
.co-score-hi { color:var(--dsw-alias-state-success-primary); }
.co-score-mid { color:var(--dsw-alias-state-warn-primary); }
.co-score-lo { color:var(--dsw-alias-state-idle-primary); }
.co-state { border:1px solid var(--dsw-alias-border-l1); border-radius:999px; padding:2px 9px;
  font-size:11.5px; display:inline-block; white-space:nowrap; }
.co-state-applied, .co-state-interview, .co-state-offer { color:var(--dsw-alias-state-success-primary); }
.co-state-rejected, .co-state-discarded { color:var(--dsw-alias-state-error-primary); }
.co-state-evaluated { color:var(--dsw-alias-brand-primary); }
.co-select { border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary); border-radius:6px; padding:3px 6px; font-size:11.5px; }
.co-queue { padding:10px 12px; display:flex; flex-direction:column; gap:6px; }
.co-queue a { color:var(--dsw-alias-brand-primary); text-decoration:none; word-break:break-all; }
.co-queue a:hover { text-decoration:underline; }
.co-empty { padding:14px 12px; color:var(--dsw-alias-label-secondary); }
.co-error { border:1px solid var(--dsw-alias-state-error-primary); border-radius:8px;
  padding:10px 12px; color:var(--dsw-alias-state-error-primary); }
.co-hint { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1);
  border-left:3px solid var(--dsw-alias-brand-primary); border-radius:8px; padding:10px 12px; }
.co-filterbar { display:flex; gap:6px; flex-wrap:wrap; }
.co-filter { border:1px solid var(--dsw-alias-border-l1); background:transparent; border-radius:999px;
  padding:3px 10px; font-size:11.5px; cursor:pointer; color:var(--dsw-alias-label-secondary); }
.co-filter-on { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary);
  border-color:var(--dsw-alias-border-l2); }
`

    // Fallback only: the page takes the authoritative list from the Host
    // (/career-ops/api/state → `states`), which reads career-ops' templates/states.yml.
    const FALLBACK_STATES = ['Evaluated', 'Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP', 'Hired']

    function scoreClass(score) {
      const n = Number.parseFloat(score)
      if (Number.isNaN(n)) return 'co-score co-score-lo'
      if (n >= 4) return 'co-score co-score-hi'
      if (n >= 3) return 'co-score co-score-mid'
      return 'co-score co-score-lo'
    }

    function Icon({ size, active }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.72 },
      },
        h('path', { d: 'M4 8.5h16v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-10z', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M9 8.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v2.5', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M12 12.2l1.1 2 2.2.3-1.6 1.6.4 2.2-2.1-1.1-2.1 1.1.4-2.2L8.7 14.5l2.2-.3 1.1-2z', fill: 'currentColor' }),
      )
    }

    function Page() {
      const [state, setState] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [busyRow, setBusyRow] = useState('')
      const [filter, setFilter] = useState('')
      const [nonce, setNonce] = useState(0)

      useEffect(() => {
        const controller = new AbortController()
        fetch('/career-ops/api/state', { signal: controller.signal })
          .then((response) => response.json())
          .then((body) => {
            if (!body || body.ok === false) throw new Error((body && body.error) || 'career-ops has no data root configured')
            setState(body)
            setLoadError('')
          })
          .catch((error) => {
            if (error.name !== 'AbortError') setLoadError(error.message)
          })
        return () => controller.abort()
      }, [nonce])

      const change = useCallback(async (row, next) => {
        setBusyRow(String(row['#'] || row.company || ''))
        try {
          const response = await fetch('/career-ops/api/status', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ entry: String(row['#'] || row.company), state: next }),
          })
          const body = await response.json()
          if (body && body.ok === false) setLoadError(body.error || 'status change failed')
          else setLoadError('')
          setNonce((n) => n + 1)
        } catch (error) {
          setLoadError(error.message)
        } finally {
          setBusyRow('')
        }
      }, [])

      const rows = (state && state.tracker) || []
      const pipeline = (state && state.pipeline) || { pending: [], blocked: [], done: 0 }
      // Canonical states come from the Host, which reads career-ops' states.yml.
      const STATES = Array.isArray(state?.states) && state.states.length ? state.states : FALLBACK_STATES
      const counts = {}
      for (const row of rows) counts[row.status || '—'] = (counts[row.status || '—'] || 0) + 1
      const visible = filter ? rows.filter((row) => row.status === filter) : rows
      const ordered = visible.slice().sort((a, b) => (Number(b['#']) || 0) - (Number(a['#']) || 0))
      const evaluated = counts.Evaluated || 0
      const applied = (counts.Applied || 0) + (counts.Interview || 0) + (counts.Offer || 0)
      const interviews = (counts.Interview || 0) + (counts.Offer || 0)
      const offers = counts.Offer || 0
      const reports = (state && state.reports) || []

      return h('div', { className: 'co-root' },
        h('style', null, CSS),
        h('div', { className: 'co-head' },
          h('div', { className: 'co-title' }, 'Career Ops'),
          h('div', { className: 'co-sub' }, state && state.dataRoot ? state.dataRoot : 'career-ops'),
          h('div', { className: 'co-spacer' }),
          h('button', { className: 'co-btn', onClick: () => setNonce((n) => n + 1) }, 'Refresh'),
        ),
        loadError ? h('div', { className: 'co-error' }, loadError) : null,
        state && state.setup && !state.setup.ready
          ? h('div', { className: 'co-hint' },
            h('b', null, 'Setup first'),
            h('div', { className: 'co-muted' }, `Missing in ${state.setup.dataRoot}: ${state.setup.missing.join(', ')}`),
            h('div', { className: 'co-muted' }, 'Paste your CV to the agent and ask it to set up career-ops, then paste a job posting to evaluate it.'))
          : null,
        h('div', { className: 'co-cards' },
          h('div', { className: 'co-card' }, h('b', null, String(pipeline.pending.length)), h('span', null, 'in queue')),
          h('div', { className: 'co-card' }, h('b', null, String(rows.length)), h('span', null, 'tracked')),
          h('div', { className: 'co-card' }, h('b', null, String(evaluated)), h('span', null, 'evaluated')),
          h('div', { className: 'co-card' }, h('b', null, String(applied)), h('span', null, 'applied')),
          h('div', { className: 'co-card' }, h('b', null, String(interviews)), h('span', null, 'interviews')),
          h('div', { className: 'co-card' }, h('b', null, String(offers)), h('span', null, 'offers')),
        ),
        h('div', { className: 'co-panel' },
          h('div', { className: 'co-panel-head' }, 'Applications tracker',
            h('div', { className: 'co-spacer' }),
            h('div', { className: 'co-filterbar' },
              h('button', { className: `co-filter ${filter === '' ? 'co-filter-on' : ''}`, onClick: () => setFilter('') }, 'all'),
              ...STATES.filter((s) => counts[s]).map((s) => h('button', {
                key: s, className: `co-filter ${filter === s ? 'co-filter-on' : ''}`, onClick: () => setFilter(s),
              }, `${s} ${counts[s]}`)))),
          ordered.length
            ? h('table', { className: 'co-table' },
              h('thead', null, h('tr', null,
                h('th', null, '#'), h('th', null, 'Company'), h('th', null, 'Role'),
                h('th', null, 'Score'), h('th', null, 'Status'), h('th', null, 'Date'), h('th', null, 'Report'))),
              h('tbody', null, ordered.map((row) => h('tr', { key: `${row['#']}-${row.company}` },
                h('td', { className: 'co-muted' }, row['#'] || '—'),
                h('td', null, row.company || '—'),
                h('td', { className: 'co-role' }, row.role || '—'),
                h('td', null, h('span', { className: scoreClass(row.score) }, row.score || '—')),
                h('td', null, busyRow === String(row['#'] || row.company)
                  ? h('span', { className: 'co-muted' }, 'saving…')
                  : h('select', {
                    className: 'co-select',
                    value: STATES.includes(row.status) ? row.status : '',
                    onChange: (event) => change(row, event.target.value),
                  },
                  STATES.includes(row.status) ? null : h('option', { value: '' }, row.status || '—'),
                  ...STATES.map((s) => h('option', { key: s, value: s }, s)))),
                h('td', { className: 'co-muted' }, row.date || '—'),
                h('td', { className: 'co-muted' }, row.report || '—')))))
            : h('div', { className: 'co-empty' }, 'No applications yet. Paste a job posting or URL to the agent, or run a scan — the tracker fills itself.')),
        h('div', { className: 'co-panel' },
          h('div', { className: 'co-panel-head' }, 'Evaluation queue',
            h('div', { className: 'co-spacer' }),
            h('div', { className: 'co-muted' }, `${pipeline.done} processed`)),
          (pipeline.pending.length || pipeline.blocked.length)
            ? h('div', { className: 'co-queue' },
              ...pipeline.pending.map((item) => h('div', { key: item.url }, h('a', { href: item.url, target: '_blank', rel: 'noreferrer' }, item.url))),
              ...pipeline.blocked.map((item) => h('div', { key: `b-${item.url}`, className: 'co-muted' }, `${item.url} — ${item.line}`)))
            : h('div', { className: 'co-empty' }, 'Queue is empty. Ask the agent to scan portals for new matches.')),
        reports.length
          ? h('div', { className: 'co-panel' },
            h('div', { className: 'co-panel-head' }, 'Recent reports'),
            h('div', { className: 'co-queue' }, reports.slice().reverse().map((name) => h('div', { key: name, className: 'co-muted' }, name))))
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The sidebar row and the central panel address each other by the same id.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'career-ops', order: 20, label: 'Career Ops' },
          Icon,
        ))
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'career-ops' },
          Page,
        ))
      },
    }
  },
})
