/**
 * ReviewPage.jsx — sessions that meet the review threshold (Phase 5),
 * per-exam scoring settings, and identity-verification requests.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Loader2, ArrowRight, SlidersHorizontal, ChevronDown, ChevronUp, Fingerprint } from 'lucide-react'
import FacultyLayout from '../../components/FacultyLayout'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../lib/supabase'
import { useExamSessions, useFacultyExams } from '../../hooks/useExamSessions'
import { toMonitorRow } from '../../review/liveSessions'
import { categoryRows, SESSION_STATUS_LABELS } from '../../review/riskView'
import { ExamPicker, LiveBadge, RiskBadge, IdentityBadge, NotProofNotice, Card } from '../../components/review/ReviewUI'
import RiskSettings from '../../components/review/RiskSettings'

const RESULT_LABELS = {
  passed: 'Passed', failed: 'Failed', inconclusive: 'Inconclusive',
  manual_review_requested: 'Manual review requested',
  no_reference_face: 'No face in reference photo', no_reference_photo: 'No reference photo',
}

function useIdentityRequests(examId, sessionStudentIds, refreshKey) {
  const [items, setItems] = useState([])
  useEffect(() => {
    if (!examId) { setItems([]); return }
    supabase.from('identity_verifications')
      .select('student_id, result, distance, attempted_at, student:students(name, student_id)')
      .eq('exam_id', examId)
      .order('attempted_at', { ascending: false })
      .then(({ data }) => setItems(data ?? []))
  }, [examId, refreshKey])
  // Students who asked for review / never verified and have no exam session.
  return useMemo(() => {
    const byStudent = new Map()
    for (const a of items) {
      if (sessionStudentIds.has(a.student_id)) continue
      if (!byStudent.has(a.student_id)) byStudent.set(a.student_id, { ...a, attempts: 0 })
      byStudent.get(a.student_id).attempts++
    }
    return [...byStudent.values()]
  }, [items, sessionStudentIds])
}

export default function ReviewPage() {
  const { profile } = useAuth()
  const [params, setParams] = useSearchParams()
  const examId = params.get('exam')
  const [showAll, setShowAll] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { exams } = useFacultyExams(profile?.id)
  const { rows, loading, live, updatedAt, reload } = useExamSessions({ examId })

  const all = useMemo(() => Object.values(rows).map(r => ({ raw: r, view: toMonitorRow(r) })), [rows])
  const list = all
    .filter(({ view }) => showAll || view.needsReview || ['in_review', 'further_review'].includes(view.reviewStatus))
    .sort((a, b) => (b.view.score ?? 0) - (a.view.score ?? 0))
  const threshold = all[0]?.raw.risk?.breakdown?.review_threshold
  const studentIds = useMemo(() => new Set(Object.values(rows).map(r => r.student?.id)), [rows])
  const identityRequests = useIdentityRequests(examId, studentIds, updatedAt)

  return (
    <FacultyLayout>
      <div className="p-8 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">Review</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Sessions that meet your review threshold, with their evidence.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <ExamPicker exams={exams} value={examId} onChange={id => setParams(id ? { exam: id } : {})} />
            {examId && <LiveBadge state={live} updatedAt={updatedAt} />}
          </div>
        </div>

        <NotProofNotice />

        {examId && (
          <Card title={<span className="inline-flex items-center gap-2"><SlidersHorizontal size={15} /> Scoring rules & review thresholds</span>}
            actions={
              <button onClick={() => setSettingsOpen(v => !v)} className="text-xs text-amber-700 dark:text-amber-400 inline-flex items-center gap-1">
                {settingsOpen ? <>Hide <ChevronUp size={13} /></> : <>Edit <ChevronDown size={13} /></>}
              </button>
            }>
            {settingsOpen
              ? <RiskSettings examId={examId} onSaved={reload} />
              : <p className="text-sm text-gray-600 dark:text-gray-400">
                  Review threshold: <strong className="text-gray-900 dark:text-white">{threshold ?? '—'}</strong> / 100.
                  Sessions are also listed when identity verification needs attention, whatever their score.
                </p>}
          </Card>
        )}

        {!examId ? (
          <p className="text-sm text-gray-500 py-12 text-center">Choose an exam to review.</p>
        ) : loading ? (
          <div className="py-16 flex justify-center"><Loader2 className="animate-spin text-amber-500" /></div>
        ) : (
          <>
            <Card title={`${showAll ? 'All sessions' : 'Sessions to review'} (${list.length})`}
              actions={
                <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
                  <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} className="accent-amber-600" />
                  Show all sessions
                </label>
              }>
              {list.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-6">No sessions meet the review threshold.</p>
              ) : (
                <div className="overflow-x-auto -m-5">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">
                      <tr className="[&>th]:px-5 [&>th]:py-3 [&>th]:text-left [&>th]:font-medium">
                        <th>Student</th><th>Score</th><th>Why listed</th><th>Main contributors</th><th>Decision</th><th />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {list.map(({ raw, view }) => {
                        const top = categoryRows(raw.risk?.breakdown).filter(c => c.contribution > 0).slice(0, 2)
                        return (
                          <tr key={view.id} className="[&>td]:px-5 [&>td]:py-3 align-top">
                            <td>
                              <p className="font-medium text-gray-900 dark:text-white">{view.name}</p>
                              <p className="text-xs text-gray-400">{view.studentNo} · {view.examStatus.replace('_', ' ')}</p>
                            </td>
                            <td><RiskBadge score={view.score} level={view.level} /></td>
                            <td className="space-y-1">
                              {view.reasons.includes('risk_score') && <span className="block text-xs text-gray-700 dark:text-gray-300">Behavioural score ≥ {threshold}</span>}
                              <IdentityBadge flag={view.identityFlag} />
                              {!view.reasons.length && <span className="text-xs text-gray-400">—</span>}
                            </td>
                            <td className="text-xs text-gray-600 dark:text-gray-400">
                              {top.length ? top.map(c => <span key={c.key} className="block">{c.label}: +{c.contribution}</span>) : '—'}
                            </td>
                            <td className="text-xs text-gray-700 dark:text-gray-300">{SESSION_STATUS_LABELS[view.reviewStatus]}</td>
                            <td>
                              <Link to={`/faculty/review/${view.id}?exam=${examId}`}
                                className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400 hover:underline whitespace-nowrap">
                                Open review <ArrowRight size={12} />
                              </Link>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {identityRequests.length > 0 && (
              <Card title={<span className="inline-flex items-center gap-2"><Fingerprint size={15} /> Identity verification without an exam session ({identityRequests.length})</span>}>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                  These students did not pass automatic face matching and have not started the exam. This is separate from behavioural alerts.
                </p>
                <ul className="divide-y divide-gray-100 dark:divide-gray-800 text-sm">
                  {identityRequests.map(r => (
                    <li key={r.student_id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-gray-900 dark:text-white">{r.student?.name} <span className="text-xs text-gray-400">{r.student?.student_id}</span></span>
                      <span className="text-xs text-gray-600 dark:text-gray-400">
                        Latest: {RESULT_LABELS[r.result] ?? r.result}{r.distance !== null && ` (distance ${Number(r.distance).toFixed(2)})`} · {r.attempts} attempt{r.attempts === 1 ? '' : 's'} · {new Date(r.attempted_at).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}
      </div>
    </FacultyLayout>
  )
}
