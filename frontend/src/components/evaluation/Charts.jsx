/**
 * Charts.jsx — small dependency-free SVG/HTML charts and the provenance
 * badge used by the Evaluation page.
 */

import { FlaskConical, Ruler, BarChart3, CircleSlash } from 'lucide-react'

const PROVENANCE = {
  measured:    { Icon: Ruler,        text: 'Measured',           cls: 'bg-green-50 text-green-800 border-green-200 dark:bg-green-900/20 dark:text-green-300 dark:border-green-800',
                 title: 'Computed from real sessions against ground truth or faculty labels.' },
  simulated:   { Icon: FlaskConical, text: 'Simulated data',     cls: 'bg-purple-50 text-purple-800 border-purple-200 dark:bg-purple-900/20 dark:text-purple-300 dark:border-purple-800',
                 title: 'From sessions marked simulated: checks the pipeline only, not detection accuracy.' },
  descriptive: { Icon: BarChart3,    text: 'Descriptive counts', cls: 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800',
                 title: 'What the system logged. Not a measure of accuracy.' },
  unavailable: { Icon: CircleSlash,  text: 'Not measured',       cls: 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700',
                 title: 'Not computed: the required data does not exist yet.' },
}

export function ProvenanceBadge({ provenance }) {
  const p = PROVENANCE[provenance] ?? PROVENANCE.unavailable
  return (
    <span title={p.title} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium whitespace-nowrap ${p.cls}`}>
      <p.Icon size={11} strokeWidth={2} /> {p.text}
    </span>
  )
}

export function Unavailable({ reason }) {
  return (
    <div className="flex items-start gap-2 text-sm text-gray-500 dark:text-gray-400">
      <ProvenanceBadge provenance="unavailable" />
      <p>{reason}</p>
    </div>
  )
}

// ── number formatting (null → "—", never 0) ─────────────────
export const fmt = (x, digits = 2) => (x == null || !Number.isFinite(Number(x)) ? '—' : Number(x).toFixed(digits))
export const pct = (x, digits = 1) => (x == null ? '—' : `${(x * 100).toFixed(digits)}%`)

/** "75.0% (95% CI 40.9–92.9%, 6/8)" */
export function Prop({ p }) {
  if (!p || p.value == null) return <span className="text-gray-400" title="Undefined for this data (denominator is 0)">—</span>
  return (
    <span>
      <span className="font-medium">{pct(p.value)}</span>
      <span className="text-gray-400 text-xs"> ({p.successes}/{p.n}; 95% CI {pct(p.ci[0], 0)}–{pct(p.ci[1], 0)})</span>
    </span>
  )
}

// ── horizontal bars (HTML) ──────────────────────────────────
export function BarChart({ rows, format = v => v, max }) {
  const top = max ?? Math.max(1, ...rows.map(r => r.value))
  return (
    <ul className="space-y-1.5">
      {rows.map(r => (
        <li key={r.label} className="grid grid-cols-[minmax(7rem,12rem)_1fr_auto] items-center gap-3 text-xs">
          <span className="truncate text-gray-700 dark:text-gray-300" title={r.label}>{r.label}</span>
          <span className="h-3 rounded bg-gray-100 dark:bg-gray-800 overflow-hidden" aria-hidden="true">
            <span className="block h-full rounded bg-amber-500" style={{ width: `${(100 * r.value) / top}%` }} />
          </span>
          <span className="tabular-nums text-gray-600 dark:text-gray-400">{format(r.value)}{r.sub ? <span className="text-gray-400"> · {r.sub}</span> : null}</span>
        </li>
      ))}
    </ul>
  )
}

// ── histogram (SVG) ─────────────────────────────────────────
export function Histogram({ bins, thresholds = [], xLabel = 'Risk score', yLabel = 'Sessions' }) {
  const W = 560, H = 220, L = 40, B = 34, T = 10, R = 10
  const max = Math.max(1, ...bins.map(b => b.count))
  const x0 = bins[0]?.lo ?? 0, x1 = bins.at(-1)?.hi ?? 100
  const sx = v => L + ((v - x0) / (x1 - x0)) * (W - L - R)
  const sy = v => H - B - (v / max) * (H - B - T)
  const ticks = [0, Math.ceil(max / 2), max]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto text-gray-500 dark:text-gray-400" role="img"
      aria-label={`${yLabel} by ${xLabel}: ${bins.map(b => `${b.lo}–${b.hi}: ${b.count}`).join(', ')}`}>
      {ticks.map(t => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={sy(t)} y2={sy(t)} className="stroke-gray-200 dark:stroke-gray-800" />
          <text x={L - 6} y={sy(t) + 4} textAnchor="end" fontSize="10" fill="currentColor">{t}</text>
        </g>
      ))}
      {bins.map(b => (
        <g key={b.lo}>
          <rect x={sx(b.lo) + 1} y={sy(b.count)} width={Math.max(0, sx(b.hi) - sx(b.lo) - 2)} height={H - B - sy(b.count)}
            className="fill-amber-500"><title>{`${b.lo}–${b.hi}: ${b.count}`}</title></rect>
          <text x={sx(b.lo)} y={H - B + 14} textAnchor="middle" fontSize="10" fill="currentColor">{b.lo}</text>
        </g>
      ))}
      <text x={sx(x1)} y={H - B + 14} textAnchor="middle" fontSize="10" fill="currentColor">{x1}</text>
      {thresholds.map(t => (
        <g key={t}>
          <line x1={sx(t)} x2={sx(t)} y1={T} y2={H - B} strokeDasharray="4 3" className="stroke-red-500" strokeWidth="1.5" />
          <text x={sx(t) + 4} y={T + 10} fontSize="10" className="fill-red-600 dark:fill-red-400">review ≥ {t}</text>
        </g>
      ))}
      <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" fontSize="11" fill="currentColor">{xLabel}</text>
    </svg>
  )
}

// ── line chart for ROC / FAR–FRR (SVG, both axes 0..1 by default) ──
const SERIES_CLS = ['stroke-amber-500', 'stroke-blue-500', 'stroke-purple-500', 'stroke-green-600']
const DOT_CLS = ['fill-amber-500', 'fill-blue-500', 'fill-purple-500', 'fill-green-600']

export function LineChart({ series, xLabel, yLabel, xDomain = [0, 1], yDomain = [0, 1], diagonal = false, markers = [], step = false }) {
  const W = 360, H = 260, L = 42, B = 38, T = 10, R = 12
  const sx = v => L + ((v - xDomain[0]) / (xDomain[1] - xDomain[0])) * (W - L - R)
  const sy = v => H - B - ((v - yDomain[0]) / (yDomain[1] - yDomain[0])) * (H - B - T)
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const path = pts => pts.filter(p => p.y != null && p.x != null).map((p, i) => {
    if (!i) return `M${sx(p.x)},${sy(p.y)}`
    return step ? `H${sx(p.x)}V${sy(p.y)}` : `L${sx(p.x)},${sy(p.y)}`
  }).join('')
  return (
    <figure className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-md h-auto text-gray-500 dark:text-gray-400" role="img" aria-label={`${yLabel} against ${xLabel}`}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={sy(yDomain[0] + t * (yDomain[1] - yDomain[0]))} y2={sy(yDomain[0] + t * (yDomain[1] - yDomain[0]))} className="stroke-gray-200 dark:stroke-gray-800" />
            <text x={L - 6} y={sy(yDomain[0] + t * (yDomain[1] - yDomain[0])) + 4} textAnchor="end" fontSize="10" fill="currentColor">{fmt(yDomain[0] + t * (yDomain[1] - yDomain[0]), 2)}</text>
            <text x={sx(xDomain[0] + t * (xDomain[1] - xDomain[0]))} y={H - B + 14} textAnchor="middle" fontSize="10" fill="currentColor">{fmt(xDomain[0] + t * (xDomain[1] - xDomain[0]), 2)}</text>
          </g>
        ))}
        {diagonal && <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} strokeDasharray="3 3" className="stroke-gray-300 dark:stroke-gray-700" />}
        {markers.map(m => (
          <g key={m.label}>
            <line x1={sx(m.x)} x2={sx(m.x)} y1={T} y2={H - B} strokeDasharray="4 3" className="stroke-red-500" />
            <text x={sx(m.x) + 4} y={T + 10} fontSize="10" className="fill-red-600 dark:fill-red-400">{m.label}</text>
          </g>
        ))}
        {series.map((s, i) => (
          <path key={s.name} d={path(s.points)} fill="none" strokeWidth="2" className={SERIES_CLS[i % SERIES_CLS.length]} />
        ))}
        <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" fontSize="11" fill="currentColor">{xLabel}</text>
        <text x={12} y={(T + H - B) / 2} textAnchor="middle" fontSize="11" fill="currentColor" transform={`rotate(-90 12 ${(T + H - B) / 2})`}>{yLabel}</text>
      </svg>
      <figcaption className="flex flex-wrap gap-3 text-xs text-gray-600 dark:text-gray-400">
        {series.map((s, i) => (
          <span key={s.name} className="inline-flex items-center gap-1.5">
            <svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="4" className={DOT_CLS[i % DOT_CLS.length]} /></svg>{s.name}
          </span>
        ))}
      </figcaption>
    </figure>
  )
}

// ── confusion matrix (HTML table) ───────────────────────────
export function ConfusionMatrix({ rowTitle, colTitle, rows, cols, cells, highlight = () => false }) {
  return (
    <table className="text-xs border-collapse">
      <thead>
        <tr>
          <th className="p-2" />
          <th colSpan={cols.length} className="p-2 text-gray-500 dark:text-gray-400 font-medium text-center">{colTitle}</th>
        </tr>
        <tr>
          <th className="p-2 text-left text-gray-500 dark:text-gray-400 font-medium">{rowTitle}</th>
          {cols.map(c => <th key={c} className="p-2 font-medium text-gray-700 dark:text-gray-300 text-center">{c}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r}>
            <th className="p-2 text-left font-medium text-gray-700 dark:text-gray-300">{r}</th>
            {cols.map((c, j) => (
              <td key={c} className={`p-2 min-w-16 text-center tabular-nums border border-gray-200 dark:border-gray-800 ${
                highlight(i, j) ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300' : 'text-gray-800 dark:text-gray-200'}`}>
                {cells[i][j]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
