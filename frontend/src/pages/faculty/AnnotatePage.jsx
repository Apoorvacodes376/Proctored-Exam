/**
 * AnnotatePage.jsx — record ground truth for one exam session (Phase 6).
 *
 * Detector alerts are deliberately NOT shown here: ground truth must come
 * from an independent record (a scripted protocol's log or a consented
 * external recording). Showing the alerts would anchor the annotator to
 * what the detectors reported and bias every metric computed from it.
 */

import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2, Plus, Trash2, Save, EyeOff } from 'lucide-react'
import FacultyLayout from '../../components/FacultyLayout'
import { supabase } from '../../lib/supabase'
import { Card } from '../../components/review/ReviewUI'
import { EVAL_CATEGORIES, CATEGORY_LABELS } from '../../evaluation/groundTruth'
import { intervalFromForm, isoToOffset, formatOffset } from '../../evaluation/annotation'

const KINDS = [
  { value: 'scripted',  label: 'Scripted trial', help: 'A consenting participant followed a written script of behaviours at recorded times. Real detector output under staged conditions.' },
  { value: 'live',      label: 'Live session',   help: 'A real exam, annotated afterwards from an independent record (e.g. a consented external recording).' },
  { value: 'simulated', label: 'Simulated',      help: 'Events were injected or synthetic, not produced by the detectors. Checks the pipeline only; excluded from all other figures.' },
]

const inputCls = 'px-3 py-2 text-sm rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500'
const EMPTY_INTERVAL = { category: '', start: '', end: '', label: '', notes: '' }

export default function AnnotatePage() {
  const { sessionId } = useParams()
  const [session, setSession] = useState(null)
  const [trial, setTrial] = useState(null)
  const [form, setForm] = useState({ data_kind: 'scripted', annotated_categories: [], annotation_method: '', notes: '' })
  const [intervals, setIntervals] = useState([])
  const [draft, setDraft] = useState(EMPTY_INTERVAL)
  const [errors, setErrors] = useState([])
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const [{ data: s, error: sErr }, { data: t }] = await Promise.all([
      supabase.from('exam_sessions').select('id, exam_id, status, started_at, submitted_at, student:students(name, student_id), exam:exams(title, duration_mins)')
        .eq('id', sessionId).maybeSingle(),
      supabase.from('evaluation_trials').select('*').eq('exam_session_id', sessionId).maybeSingle(),
    ])
    if (sErr || !s) { setMsg(sErr?.message ?? 'Session not found.'); setLoading(false); return }
    setSession(s)
    setTrial(t ?? null)
    if (t) {
      setForm({ data_kind: t.data_kind, annotated_categories: t.annotated_categories, annotation_method: t.annotation_method ?? '', notes: t.notes ?? '' })
      const { data: gi } = await supabase.from('ground_truth_intervals').select('*').eq('trial_id', t.id).order('starts_at')
      setIntervals(gi ?? [])
    }
    setLoading(false)
  }, [sessionId])

  useEffect(() => { load() }, [load])

  async function saveTrial() {
    setSaving(true); setMsg('')
    const row = { exam_session_id: sessionId, exam_id: session.exam_id, ...form,
      annotation_method: form.annotation_method.trim() || null, notes: form.notes.trim() || null }
    const { data, error } = await supabase.from('evaluation_trials').upsert(row, { onConflict: 'exam_session_id' }).select().single()
    setSaving(false)
    if (error) { setMsg(error.message); return }
    setTrial(data)
    setMsg('Saved.')
  }

  async function addInterval(e) {
    e.preventDefault()
    const { errors: errs, value } = intervalFromForm(draft, session.started_at)
    setErrors(errs)
    if (errs.length) return
    const { error } = await supabase.from('ground_truth_intervals').insert({ ...value, trial_id: trial.id })
    if (error) { setErrors([error.message]); return }
    setDraft(d => ({ ...EMPTY_INTERVAL, category: d.category }))
    load()
  }

  async function removeInterval(id) {
    const { error } = await supabase.from('ground_truth_intervals').delete().eq('id', id)
    if (error) setMsg(error.message); else setIntervals(xs => xs.filter(x => x.id !== id))
  }

  const toggleCategory = c => setForm(f => ({ ...f,
    annotated_categories: f.annotated_categories.includes(c) ? f.annotated_categories.filter(x => x !== c) : [...f.annotated_categories, c] }))

  return (
    <FacultyLayout>
      <div className="p-8 space-y-5 max-w-4xl">
        <Link to={session ? `/faculty/evaluation?exam=${session.exam_id}` : '/faculty/evaluation'} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white">
          <ArrowLeft size={14} /> Evaluation
        </Link>
        {loading ? <Loader2 className="animate-spin text-amber-500" /> : !session ? <p className="text-sm text-red-600">{msg}</p> : (
          <>
            <div>
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">Ground truth — {session.student?.name}</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {session.exam?.title} · started {new Date(session.started_at).toLocaleString()} · {session.status.replace('_', ' ')}
              </p>
            </div>

            <div className="flex items-start gap-2 px-4 py-3 rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-sm text-amber-900 dark:text-amber-200">
              <EyeOff size={16} className="shrink-0 mt-0.5" />
              <p>Detector alerts are hidden on this page on purpose. Annotate from your independent record so the ground truth is not influenced by what the system reported.</p>
            </div>

            <Card title="About this annotation" actions={
              <button onClick={saveTrial} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
              </button>}>
              <div className="space-y-5">
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium text-gray-900 dark:text-white mb-1">Type of data</legend>
                  {KINDS.map(k => (
                    <label key={k.value} className="flex items-start gap-2 text-sm">
                      <input type="radio" name="kind" value={k.value} checked={form.data_kind === k.value}
                        onChange={() => setForm(f => ({ ...f, data_kind: k.value }))} className="mt-1" />
                      <span><span className="font-medium text-gray-900 dark:text-white">{k.label}</span>
                        <span className="block text-xs text-gray-500 dark:text-gray-400">{k.help}</span></span>
                    </label>
                  ))}
                </fieldset>
                <fieldset>
                  <legend className="text-sm font-medium text-gray-900 dark:text-white">Categories annotated completely</legend>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    Tick a category only if every occurrence in this session is recorded below. Unticked categories are treated as unknown, not as "nothing happened".
                  </p>
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    {EVAL_CATEGORIES.map(c => (
                      <label key={c} className="inline-flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                        <input type="checkbox" checked={form.annotated_categories.includes(c)} onChange={() => toggleCategory(c)} /> {CATEGORY_LABELS[c]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="grid sm:grid-cols-2 gap-4">
                  <label className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
                    <span>How was this annotated?</span>
                    <input className={`${inputCls} w-full`} value={form.annotation_method} placeholder="e.g. script v2 timings, checked against phone video"
                      onChange={e => setForm(f => ({ ...f, annotation_method: e.target.value }))} />
                  </label>
                  <label className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
                    <span>Notes</span>
                    <input className={`${inputCls} w-full`} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
                  </label>
                </div>
                {msg && <p className="text-xs text-gray-600 dark:text-gray-400">{msg}</p>}
              </div>
            </Card>

            <Card title="What actually happened">
              {!trial ? <p className="text-sm text-gray-500">Save the annotation details first.</p> : (
                <div className="space-y-4">
                  <form onSubmit={addInterval} className="grid sm:grid-cols-[1fr_6rem_6rem_1fr_auto] gap-2 items-end">
                    <label className="text-xs text-gray-500 space-y-1"><span>Category</span>
                      <select className={`${inputCls} w-full`} value={draft.category} onChange={e => setDraft(d => ({ ...d, category: e.target.value }))}>
                        <option value="">Choose…</option>
                        {EVAL_CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                      </select>
                    </label>
                    <label className="text-xs text-gray-500 space-y-1"><span>Start (m:ss)</span>
                      <input className={`${inputCls} w-full`} value={draft.start} placeholder="1:15" onChange={e => setDraft(d => ({ ...d, start: e.target.value }))} />
                    </label>
                    <label className="text-xs text-gray-500 space-y-1"><span>End (optional)</span>
                      <input className={`${inputCls} w-full`} value={draft.end} placeholder="1:40" onChange={e => setDraft(d => ({ ...d, end: e.target.value }))} />
                    </label>
                    <label className="text-xs text-gray-500 space-y-1"><span>Label (e.g. object)</span>
                      <input className={`${inputCls} w-full`} value={draft.label} placeholder="cell phone" onChange={e => setDraft(d => ({ ...d, label: e.target.value }))} />
                    </label>
                    <button className="inline-flex items-center justify-center gap-1 px-3 py-2 text-sm rounded-xl bg-amber-600 hover:bg-amber-700 text-white"><Plus size={14} /> Add</button>
                  </form>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Times are offsets from the session start ({new Date(session.started_at).toLocaleTimeString()}). Leave End empty for an instantaneous behaviour such as a tab switch. Object labels use COCO names (cell phone, book, laptop…).</p>
                  {errors.length > 0 && <ul className="text-xs text-red-600 list-disc pl-5">{errors.map(e => <li key={e}>{e}</li>)}</ul>}
                  {intervals.length ? (
                    <table className="w-full text-sm">
                      <thead className="text-xs text-gray-500"><tr><th className="text-left py-1">Category</th><th className="text-left">Start</th><th className="text-left">End</th><th className="text-left">Label</th><th /></tr></thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                        {intervals.map(g => (
                          <tr key={g.id} className="text-gray-800 dark:text-gray-200">
                            <td className="py-1.5">{CATEGORY_LABELS[g.category]}</td>
                            <td>{formatOffset(isoToOffset(session.started_at, g.starts_at))}</td>
                            <td>{g.ends_at ? formatOffset(isoToOffset(session.started_at, g.ends_at)) : '—'}</td>
                            <td>{g.label ?? ''}</td>
                            <td className="text-right"><button onClick={() => removeInterval(g.id)} className="text-gray-400 hover:text-red-600" title="Delete"><Trash2 size={14} /></button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="text-sm text-gray-500">No intervals yet. If nothing happened in a ticked category, that is valid ground truth (every alert in it will count as a false alert).</p>}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </FacultyLayout>
  )
}
