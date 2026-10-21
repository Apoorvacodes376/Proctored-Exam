/**
 * SessionReviewPage.jsx — review one exam session (Phase 5):
 * score breakdown, identity verification (kept separate), chronological
 * events with confidence and evidence, per-event review, and the
 * session decision with its explanation and history.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Loader2, Image as ImageIcon, CheckCircle2, AlertCircle, Fingerprint, History, Save } from 'lucide-react'
import FacultyLayout from '../../components/FacultyLayout'
import Modal from '../../components/Modal'
import { supabase } from '../../lib/supabase'
import { useExamSessions } from '../../hooks/useExamSessions'
import { toMonitorRow } from '../../review/liveSessions'
import { createEvidenceResolver } from '../../review/evidence'
import {
  categoryRows, eventTimeline, identitySummary, formatDuration, formatConfidence, reviewReasonText,
  DECISION_LABELS, SESSION_STATUS_LABELS, OUTCOME_LABELS,
} from '../../review/riskView'
import { LiveBadge, RiskBadge, IdentityBadge, NotProofNotice, Card } from '../../components/review/ReviewUI'

const inputCls = 'w-full px-3 py-2 text-sm rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500'

function offset(startedAt, at) {
  const s = Math.max(0, Math.round((Date.parse(at) - Date.parse(startedAt)) / 1000))
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ── Evidence ────────────────────────────────────────────────────

function Evidence({ resolver, snapshotId, label }) {
  const [state, setState] = useState({ loading: false })
  const [open, setOpen] = useState(false)

  async function show() {
    setState({ loading: true })
    const r = await resolver.get(snapshotId)
    setState({ loading: false, ...r })
    if (r.url) setOpen(true)
  }

  if (!snapshotId) return <span className="text-xs text-gray-400">—</span>
  return (
    <>
      <button onClick={show} className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400 hover:underline">
        {state.loading ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={12} />} View
      </button>
      {state.error && <span className="block text-xs text-red-600">{state.error}</span>}
      <Modal open={open} onClose={() => setOpen(false)} title={`Evidence — ${label}`} maxWidth="max-w-3xl">
        {state.url && (
          <figure className="space-y-2">
            <img src={state.url} alt={`Webcam snapshot captured at the ${label} alert`} className="w-full rounded-xl bg-black" />
            <figcaption className="text-xs text-gray-500">
              Captured {state.capturedAt ? new Date(state.capturedAt).toLocaleString() : ''} · private link expires in a few minutes
            </figcaption>
          </figure>
        )}
      </Modal>
    </>
  )
}

// ── Per-event review ────────────────────────────────────────────

function EventReview({ eventId, review, onSaved }) {
  const [decision, setDecision] = useState(review?.decision ?? 'pending')
  const [notes, setNotes] = useState(review?.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const dirty = decision !== (review?.decision ?? 'pending') || notes !== (review?.notes ?? '')

  async function save() {
    setSaving(true); setErr('')
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('faculty_reviews').upsert(
      { proctoring_event_id: eventId, reviewed_by: user.id, decision, notes: notes.trim() || null },
      { onConflict: 'proctoring_event_id' })
    setSaving(false)
    if (error) setErr(error.message)
    else onSaved()
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select value={decision} onChange={e => setDecision(e.target.value)} className="px-2 py-1 text-xs rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white">
        {Object.entries(DECISION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Note (optional)"
        className="flex-1 min-w-32 px-2 py-1 text-xs rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
      {dirty && (
        <button onClick={save} disabled={saving} className="px-2.5 py-1 text-xs font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
      {!dirty && review?.reviewed_at && <CheckCircle2 size={14} className="text-green-600" title={`Reviewed ${new Date(review.reviewed_at).toLocaleString()}`} />}
      {err && <span className="text-xs text-red-600 w-full">{err}</span>}
    </div>
  )
}

// ── Session decision ────────────────────────────────────────────

function SessionDecision({ sessionId, examId, current, history, onSaved }) {
  const [status, setStatus] = useState(current?.status ?? 'in_review')
  const [outcome, setOutcome] = useState(current?.outcome ?? '')
  const [explanation, setExplanation] = useState(current?.explanation ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const needsExplanation = status === 'cleared' || status === 'further_review' || !!outcome

  async function save() {
    if (needsExplanation && explanation.trim().length < 10) { setErr('Please explain this decision (at least 10 characters).'); return }
    setSaving(true); setErr('')
    const { error } = await supabase.from('session_reviews').upsert({
      exam_session_id: sessionId, exam_id: examId, status, outcome: outcome || null, explanation: explanation.trim() || null,
    }, { onConflict: 'exam_session_id' })
    setSaving(false)
    if (error) setErr(error.message)
    else onSaved()
  }

  return (
    <div className="space-y-4 text-sm">
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Before evaluation, this exam…</span>
          <select value={status} onChange={e => setStatus(e.target.value)} className={inputCls}>
            <option value="in_review">is being reviewed</option>
            <option value="cleared">is cleared — proceed to evaluation</option>
            <option value="further_review">needs further review — hold evaluation</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Your conclusion (optional)</span>
          <select value={outcome} onChange={e => setOutcome(e.target.value)} className={inputCls}>
            <option value="">No conclusion yet</option>
            {Object.entries(OUTCOME_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Explanation {needsExplanation && <span className="text-red-500">*</span>}</span>
        <textarea value={explanation} onChange={e => setExplanation(e.target.value)} rows={3} className={inputCls}
          placeholder="What you reviewed and why you reached this decision (e.g. evidence checked, student contacted)." />
      </label>
      {err && <p className="text-xs text-red-600 flex items-center gap-1"><AlertCircle size={13} /> {err}</p>}
      <button onClick={save} disabled={saving}
        className="inline-flex items-center gap-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white font-medium rounded-xl">
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Record decision
      </button>

      {history.length > 0 && (
        <div className="pt-3 border-t border-gray-200 dark:border-gray-800">
          <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2 inline-flex items-center gap-1"><History size={13} /> Decision history</p>
          <ol className="space-y-2">
            {history.map(h => (
              <li key={h.id} className="text-xs">
                <span className="font-medium text-gray-900 dark:text-white">{SESSION_STATUS_LABELS[h.status]}</span>
                {h.outcome && <> · {OUTCOME_LABELS[h.outcome]}</>}
                <span className="text-gray-400"> · {new Date(h.decided_at).toLocaleString()} · score then {h.score_at_decision ?? '—'}</span>
                {h.explanation && <p className="text-gray-600 dark:text-gray-400 mt-0.5">{h.explanation}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────

export default function SessionReviewPage() {
  const { sessionId } = useParams()
  const [params] = useSearchParams()
  const [examId, setExamId] = useState(params.get('exam'))
  const [exam, setExam] = useState(null)
  const [extra, setExtra] = useState({ reviews: {}, session: null, history: [], attempts: [] })
  const [filter, setFilter] = useState('all')
  const resolver = useMemo(() => createEvidenceResolver(supabase), [])

  // Resolve the exam if we arrived without ?exam=
  useEffect(() => {
    if (examId) return
    supabase.from('exam_sessions').select('exam_id').eq('id', sessionId).maybeSingle()
      .then(({ data }) => data && setExamId(data.exam_id))
  }, [examId, sessionId])

  useEffect(() => {
    if (!examId) return
    supabase.from('exams').select('id, title, subject').eq('id', examId).maybeSingle().then(({ data }) => setExam(data))
  }, [examId])

  const { rows, loading, live, updatedAt } = useExamSessions({ examId, sessionId })
  const raw = rows[sessionId]
  const view = raw ? toMonitorRow(raw) : null
  const breakdown = raw?.risk?.breakdown

  const loadExtra = useCallback(async () => {
    if (!raw) return
    const ids = (breakdown?.events ?? []).map(e => e.id)
    const [reviews, session, history, attempts] = await Promise.all([
      ids.length
        ? supabase.from('faculty_reviews').select('proctoring_event_id, decision, notes, reviewed_at').in('proctoring_event_id', ids)
        : Promise.resolve({ data: [] }),
      supabase.from('session_reviews').select('*').eq('exam_session_id', sessionId).maybeSingle(),
      supabase.from('session_review_history').select('*').eq('exam_session_id', sessionId).order('decided_at', { ascending: false }),
      supabase.from('identity_verifications').select('id, result, distance, threshold, attempted_at')
        .eq('exam_id', raw.exam_id).eq('student_id', raw.student?.id).order('attempted_at'),
    ])
    setExtra({
      reviews:  Object.fromEntries((reviews.data ?? []).map(r => [r.proctoring_event_id, r])),
      session:  session.data,
      history:  history.data ?? [],
      attempts: attempts.data ?? [],
    })
  }, [raw, breakdown, sessionId])

  useEffect(() => { loadExtra() }, [loadExtra])

  const timeline = useMemo(() => eventTimeline(breakdown).filter(e =>
    filter === 'all' ? true
    : filter === 'scored' ? e.scored
    : filter === 'evidence' ? !!e.snapshot_id
    : !extra.reviews[e.id] || extra.reviews[e.id].decision === 'pending'), [breakdown, filter, extra.reviews])
  const cats = categoryRows(breakdown)
  const identity = identitySummary(breakdown?.identity)

  return (
    <FacultyLayout>
      <div className="p-8 space-y-5">
        <Link to={`/faculty/review${examId ? `?exam=${examId}` : ''}`} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white">
          <ArrowLeft size={14} /> Back to review list
        </Link>

        {loading || !raw ? (
          <div className="py-16 flex justify-center">{loading ? <Loader2 className="animate-spin text-amber-500" /> : <p className="text-sm text-gray-500">Session not found.</p>}</div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="text-xl font-bold text-gray-900 dark:text-white">{view.name} <span className="text-sm font-normal text-gray-400">{view.studentNo}</span></h1>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                  {exam?.title} · {view.examStatus.replace('_', ' ')} · started {new Date(raw.started_at).toLocaleString()}
                  {raw.submitted_at && ` · submitted ${new Date(raw.submitted_at).toLocaleString()}`}
                </p>
              </div>
              <LiveBadge state={live} updatedAt={updatedAt} />
            </div>

            <NotProofNotice />

            <div className="grid lg:grid-cols-3 gap-5">
              <Card title="Behavioural risk score" className="lg:col-span-2">
                <div className="flex flex-wrap items-center gap-4 mb-4">
                  <p className="text-4xl font-bold tabular-nums text-gray-900 dark:text-white">{view.score ?? '—'}<span className="text-base font-normal text-gray-400"> / 100</span></p>
                  <RiskBadge score={view.score} level={view.level} />
                  <div className="text-xs text-gray-600 dark:text-gray-400">
                    <p>Review threshold {breakdown?.review_threshold} · high {breakdown?.high_threshold}</p>
                    {reviewReasonText(view.reasons, breakdown).map(t => <p key={t} className="font-medium text-gray-900 dark:text-white">{t}</p>)}
                    {breakdown?.open_episodes > 0 && <p>{breakdown.open_episodes} episode(s) still ongoing — score updates live.</p>}
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-gray-500 dark:text-gray-400">
                      <tr className="[&>th]:text-left [&>th]:py-2 [&>th]:pr-3 [&>th]:font-medium">
                        <th>Category</th><th>Alerts</th><th>Counted</th><th>Time</th><th>How it was scored</th><th className="text-right">Points</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {cats.map(c => (
                        <tr key={c.key} className="[&>td]:py-2 [&>td]:pr-3 align-top">
                          <td className="font-medium text-gray-900 dark:text-white">{c.label}</td>
                          <td className="tabular-nums">{c.events}</td>
                          <td className="text-xs text-gray-600 dark:text-gray-400">
                            {c.counted}
                            {c.duplicates > 0 && ` (+${c.duplicates} merged)`}
                            {c.dismissed > 0 && `, ${c.dismissed} dismissed`}
                            {c.belowConfidence > 0 && `, ${c.belowConfidence} low-confidence`}
                          </td>
                          <td className="text-xs tabular-nums">{c.durationS ? formatDuration(c.durationS) : '—'}</td>
                          <td className="text-xs text-gray-500 dark:text-gray-400">{c.explanation}</td>
                          <td className="text-right">
                            <span className="tabular-nums font-semibold text-gray-900 dark:text-white">{c.contribution}</span>
                            <div className="h-1.5 mt-1 rounded bg-gray-100 dark:bg-gray-800 w-20 ml-auto">
                              <div className="h-1.5 rounded bg-amber-500" style={{ width: `${Math.round(c.normalised * 100)}%` }} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card title={<span className="inline-flex items-center gap-2"><Fingerprint size={15} /> Identity verification</span>}>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Reported separately — not part of the behavioural score.</p>
                <div className="flex items-center gap-2 mb-2">
                  <IdentityBadge flag={identity.flag} />
                  <span className="text-sm text-gray-900 dark:text-white">{identity.flag ? 'Needs attention' : 'No identity concerns flagged'}</span>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-400">{identity.headline}</p>
                {identity.reasons.map(r => <p key={r} className="text-sm text-violet-700 dark:text-violet-300 mt-1">• {r}</p>)}
                {extra.attempts.length > 0 && (
                  <ol className="mt-3 space-y-1 text-xs text-gray-600 dark:text-gray-400">
                    {extra.attempts.map(a => (
                      <li key={a.id}>
                        {new Date(a.attempted_at).toLocaleTimeString()} — {a.result.replaceAll('_', ' ')}
                        {a.distance !== null && ` · distance ${Number(a.distance).toFixed(3)} (threshold ${Number(a.threshold).toFixed(2)}; lower = closer)`}
                      </li>
                    ))}
                  </ol>
                )}
              </Card>
            </div>

            <Card title="Decision" >
              <SessionDecision key={extra.session?.updated_at ?? 'new'} sessionId={sessionId} examId={raw.exam_id}
                current={extra.session} history={extra.history} onSaved={loadExtra} />
            </Card>

            <Card title={`Events (${eventTimeline(breakdown).length})`}
              actions={
                <select value={filter} onChange={e => setFilter(e.target.value)} className="px-2 py-1 text-xs rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white">
                  <option value="all">All, oldest first</option>
                  <option value="scored">Counted in score</option>
                  <option value="evidence">With evidence</option>
                  <option value="unreviewed">Not yet reviewed</option>
                </select>
              }>
              {timeline.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-4">No events.</p>
              ) : (
                <div className="overflow-x-auto -m-5">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">
                      <tr className="[&>th]:px-4 [&>th]:py-2.5 [&>th]:text-left [&>th]:font-medium [&>th]:whitespace-nowrap">
                        <th>Time</th><th>Event</th><th>Duration</th><th>Confidence</th><th>In score</th><th>Evidence</th><th className="min-w-72">Your review</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {timeline.map(e => (
                        <tr key={e.id} className="[&>td]:px-4 [&>td]:py-2.5 align-top">
                          <td className="whitespace-nowrap">
                            <span className="tabular-nums text-gray-900 dark:text-white">{offset(raw.started_at, e.occurred_at)}</span>
                            <span className="block text-xs text-gray-400">{new Date(e.occurred_at).toLocaleTimeString()}</span>
                          </td>
                          <td>
                            <span className="font-medium text-gray-900 dark:text-white">{e.label}</span>
                            <span className="block text-xs text-gray-400 capitalize">{e.severity}</span>
                          </td>
                          <td className="text-xs tabular-nums whitespace-nowrap">
                            {e.open ? <span className="text-red-600">{formatDuration(e.duration_s)} · ongoing</span> : formatDuration(e.duration_s)}
                          </td>
                          <td className="text-xs tabular-nums">{formatConfidence(e.confidence)}</td>
                          <td className="text-xs">
                            <span className={e.scored ? 'text-gray-900 dark:text-white' : 'text-gray-400'}>{e.statusLabel}</span>
                            {e.points > 0 && <span className="block text-gray-400 tabular-nums">+{e.points} units</span>}
                          </td>
                          <td><Evidence resolver={resolver} snapshotId={e.snapshot_id} label={e.label} /></td>
                          <td><EventReview key={`${e.id}-${extra.reviews[e.id]?.reviewed_at}`} eventId={e.id} review={extra.reviews[e.id]} onSaved={loadExtra} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-xs text-gray-400 mt-6">
                Dismissing an event removes it from the score; the event and its evidence stay on record.
                “Confirmed” means the behaviour was detected correctly — it is not a misconduct finding.
              </p>
            </Card>
          </>
        )}
      </div>
    </FacultyLayout>
  )
}
