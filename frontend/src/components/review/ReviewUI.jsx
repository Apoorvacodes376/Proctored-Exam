/**
 * Small shared pieces for the faculty monitoring and review pages.
 */

import { Radio, WifiOff, Loader2, Info, Fingerprint } from 'lucide-react'

export function ExamPicker({ exams, value, onChange }) {
  return (
    <select value={value ?? ''} onChange={e => onChange(e.target.value || null)}
      className="px-3 py-2 text-sm rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500 max-w-full">
      <option value="">Select an exam…</option>
      {exams.map(e => (
        <option key={e.id} value={e.id}>{e.title} — {e.subject} ({e.exam_date})</option>
      ))}
    </select>
  )
}

export function LiveBadge({ state, updatedAt }) {
  const map = {
    live:         { cls: 'text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800', Icon: Radio,   text: 'Live' },
    connecting:   { cls: 'text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700',         Icon: Loader2, text: 'Connecting…', spin: true },
    reconnecting: { cls: 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800', Icon: Loader2, text: 'Reconnecting…', spin: true },
    error:        { cls: 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',               Icon: WifiOff, text: 'Live updates unavailable — refreshing every minute' },
  }
  const m = map[state] ?? map.connecting
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium ${m.cls}`}
      title={updatedAt ? `Last update ${new Date(updatedAt).toLocaleTimeString()}` : undefined}>
      <m.Icon size={12} strokeWidth={2} className={m.spin ? 'animate-spin' : state === 'live' ? 'animate-pulse' : ''} />
      {m.text}
    </span>
  )
}

const LEVEL_CLS = {
  low:      'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  medium:   'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  high:     'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  critical: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
}

export function RiskBadge({ score, level }) {
  if (score === null || score === undefined) return <span className="text-xs text-gray-400">—</span>
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold tabular-nums ${LEVEL_CLS[level] ?? LEVEL_CLS.low}`}
      title={`Behavioural risk score ${score} / 100 (${level})`}>
      {Number(score).toFixed(0)}
    </span>
  )
}

export function IdentityBadge({ flag }) {
  if (!flag) return null
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300"
      title="Identity verification needs attention — reported separately from the behavioural score">
      <Fingerprint size={11} strokeWidth={2} /> Identity
    </span>
  )
}

export function NotProofNotice() {
  return (
    <div className="flex items-start gap-2 px-4 py-3 rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-sm text-blue-800 dark:text-blue-300">
      <Info size={16} strokeWidth={1.75} className="shrink-0 mt-0.5" />
      <p>
        Risk scores and alerts come from automated, browser-based detection and can be wrong. A high score is a
        reason to look more closely — it is <strong>not</strong> proof of misconduct and never disqualifies a student
        automatically. All decisions are yours.
      </p>
    </div>
  )
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h2>
          {actions}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  )
}
