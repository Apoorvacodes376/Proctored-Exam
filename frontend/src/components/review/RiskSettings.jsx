/**
 * RiskSettings.jsx — per-exam, faculty-configurable scoring rules and
 * review thresholds. Saving recomputes every session's score (DB trigger).
 */

import { useEffect, useState } from 'react'
import { Loader2, RotateCcw, Save, AlertCircle, CheckCircle2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'

const GLOBAL_FIELDS = [
  ['review_threshold', 'Review threshold (0–100)', 'Sessions at or above this score are listed for review.', 1],
  ['high_threshold',   'High-risk threshold (0–100)', 'Shown as "critical" level. Must be ≥ review threshold.', 1],
  ['dedupe_window_s',  'Duplicate window (s)', 'A repeat of the same alert starting within this time adds duration but no extra count.', 1],
  ['min_confidence',   'Minimum confidence (0–1)', 'Detections below this confidence are listed but not scored.', 0.05],
  ['max_episode_s',    'Longest episode counted (s)', 'Caps how much one long episode can add.', 10],
]

function NumberInput({ value, onChange, step = 1, min = 0, max }) {
  return (
    <input type="number" value={value ?? ''} step={step} min={min} max={max}
      onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      className="w-24 px-2 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white tabular-nums focus:outline-none focus:ring-2 focus:ring-amber-500" />
  )
}

export default function RiskSettings({ examId, onSaved }) {
  const [cfg, setCfg]         = useState(null)
  const [defaults, setDefaults] = useState(null)
  const [custom, setCustom]   = useState(false)
  const [saving, setSaving]   = useState(false)
  const [errors, setErrors]   = useState([])
  const [saved, setSaved]     = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const [{ data: eff, error }, { data: def }, { data: row }] = await Promise.all([
        supabase.rpc('get_risk_config', { p_exam_id: examId }),
        supabase.rpc('default_risk_config'),
        supabase.from('exam_risk_settings').select('exam_id').eq('exam_id', examId).maybeSingle(),
      ])
      if (cancelled) return
      if (error) { setErrors([error.message]); return }
      setCfg(eff); setDefaults(def); setCustom(!!row)
    }
    setCfg(null); setErrors([]); setSaved(false)
    load()
    return () => { cancelled = true }
  }, [examId])

  const set = (path, value) => {
    setSaved(false)
    setCfg(prev => {
      const next = structuredClone(prev)
      let o = next
      for (const k of path.slice(0, -1)) o = o[k]
      o[path.at(-1)] = value
      return next
    })
  }

  async function save() {
    setSaving(true); setErrors([]); setSaved(false)
    const { data: problems, error: vErr } = await supabase.rpc('risk_config_errors', { cfg })
    if (vErr || problems?.length) { setErrors(vErr ? [vErr.message] : problems); setSaving(false); return }
    const { error } = await supabase.from('exam_risk_settings').upsert({ exam_id: examId, config: cfg }, { onConflict: 'exam_id' })
    setSaving(false)
    if (error) { setErrors([error.message]); return }
    setCustom(true); setSaved(true); onSaved?.()
  }

  async function reset() {
    setSaving(true); setErrors([])
    const { error } = await supabase.from('exam_risk_settings').delete().eq('exam_id', examId)
    setSaving(false)
    if (error) { setErrors([error.message]); return }
    setCfg(structuredClone(defaults)); setCustom(false); setSaved(true); onSaved?.()
  }

  if (!cfg) {
    return errors.length
      ? <p className="text-sm text-red-600">{errors[0]}</p>
      : <div className="py-6 flex justify-center"><Loader2 className="animate-spin text-amber-500" /></div>
  }

  const totalWeight = Object.values(cfg.categories).reduce((s, c) => s + (Number(c.weight) || 0), 0)

  return (
    <div className="space-y-5 text-sm">
      <p className="text-gray-600 dark:text-gray-400">
        <strong className="text-gray-900 dark:text-white">How the score works.</strong> Each alert counts once
        (× its type factor × detection confidence), plus one more unit for every “seconds per unit” it lasted.
        A category's total is divided by its saturation (capped at 100%) and multiplied by its weight.
        The score is the weighted sum on a 0–100 scale. Identity verification is <em>not</em> part of the score;
        it raises its own review flag after
        {' '}<NumberInput value={cfg.identity.failed_attempts_for_review} min={1} onChange={v => set(['identity', 'failed_attempts_for_review'], v)} />{' '}
        failed or inconclusive face matches, or when a student asks for manual review.
      </p>

      <div className="grid sm:grid-cols-2 gap-3">
        {GLOBAL_FIELDS.map(([key, label, help, step]) => (
          <label key={key} className="flex items-start justify-between gap-3 p-3 rounded-xl border border-gray-200 dark:border-gray-800">
            <span>
              <span className="block font-medium text-gray-900 dark:text-white">{label}</span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">{help}</span>
            </span>
            <NumberInput value={cfg[key]} step={step} onChange={v => set([key], v)} />
          </label>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 dark:text-gray-400">
            <tr className="[&>th]:text-left [&>th]:py-2 [&>th]:pr-3 [&>th]:font-medium">
              <th>Category</th><th>Weight</th><th>Saturation (alerts)</th><th>Seconds per unit</th><th>Alert types (factor)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {Object.entries(cfg.categories).map(([key, c]) => (
              <tr key={key} className="[&>td]:py-2 [&>td]:pr-3">
                <td className="font-medium text-gray-900 dark:text-white">{c.label}</td>
                <td>
                  <NumberInput value={c.weight} onChange={v => set(['categories', key, 'weight'], v)} />
                  <span className="ml-2 text-xs text-gray-400">{totalWeight ? Math.round(100 * c.weight / totalWeight) : 0}%</span>
                </td>
                <td><NumberInput value={c.saturation} step={0.5} min={0.5} onChange={v => set(['categories', key, 'saturation'], v)} /></td>
                <td><NumberInput value={c.seconds_per_unit} step={5} onChange={v => set(['categories', key, 'seconds_per_unit'], v)} /></td>
                <td className="text-xs text-gray-500 dark:text-gray-400">
                  {Object.entries(c.types).map(([t, f]) => `${t} (${f})`).join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {errors.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400">
          <AlertCircle size={15} className="shrink-0 mt-0.5" />
          <ul className="list-disc pl-4">{errors.map(e => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={save} disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white font-medium rounded-xl">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save and recalculate
        </button>
        {custom && (
          <button onClick={reset} disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-xl text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
            <RotateCcw size={14} /> Reset to defaults
          </button>
        )}
        <span className="text-xs text-gray-500">{custom ? 'Custom settings for this exam.' : 'Using default settings.'}</span>
        {saved && <span className="inline-flex items-center gap-1 text-xs text-green-600"><CheckCircle2 size={13} /> Saved — scores recalculated.</span>}
      </div>
    </div>
  )
}
