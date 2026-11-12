/**
 * MonitorPage.jsx — live faculty monitoring dashboard (Phase 5).
 * Shows students currently taking the selected exam, updated in real time
 * over Supabase Realtime (WebSocket).
 */

import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Camera, VideoOff, Mic, MicOff, Eye, EyeOff, Loader2, AlertCircle, ArrowRight, HelpCircle } from 'lucide-react'
import FacultyLayout from '../../components/FacultyLayout'
import { useAuth } from '../../context/AuthContext'
import { useExamSessions, useFacultyExams, useNow } from '../../hooks/useExamSessions'
import { toMonitorRow, sortRows } from '../../review/liveSessions'
import { ExamPicker, LiveBadge, RiskBadge, IdentityBadge, NotProofNotice } from '../../components/review/ReviewUI'

function ago(ms) {
  if (ms === null) return 'never'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}

function Device({ state, Ok, Bad, label }) {
  const cls = state === 'ok' ? 'text-green-600 dark:text-green-400'
    : state === 'lost' ? 'text-red-500' : 'text-gray-400'
  const Icon = state === 'lost' ? Bad : state === 'ok' ? Ok : HelpCircle
  return <span className={`inline-flex ${cls}`} title={`${label}: ${state}`}><Icon size={15} strokeWidth={1.75} /></span>
}

function Count({ n, warn = 1, now = false, title }) {
  return (
    <span title={title} className={`tabular-nums text-sm ${n >= warn ? 'font-semibold text-gray-900 dark:text-white' : 'text-gray-400'} ${now ? 'text-red-600 dark:text-red-400' : ''}`}>
      {n}{now && <span className="ml-1 text-[10px] font-bold uppercase">now</span>}
    </span>
  )
}

export default function MonitorPage() {
  const { profile } = useAuth()
  const [params, setParams] = useSearchParams()
  const examId = params.get('exam')
  const [showFinished, setShowFinished] = useState(false)
  const { exams, loading: examsLoading } = useFacultyExams(profile?.id)
  const { rows, loading, error, live, updatedAt } = useExamSessions({ examId })
  const now = useNow(5_000)

  const view = useMemo(() => sortRows(
    Object.values(rows)
      .filter(r => showFinished || r.status === 'in_progress')
      .map(r => toMonitorRow(r, now)),
  ), [rows, now, showFinished])

  const inProgress = Object.values(rows).filter(r => r.status === 'in_progress').length
  const online = view.filter(r => r.online).length

  return (
    <FacultyLayout>
      <div className="p-8 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">Live Monitoring</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Students currently taking the exam, updated in real time.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <ExamPicker exams={exams} value={examId} onChange={id => setParams(id ? { exam: id } : {})} />
            {examId && <LiveBadge state={live} updatedAt={updatedAt} />}
          </div>
        </div>

        <NotProofNotice />

        {!examId ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 py-12 text-center">
            {examsLoading ? 'Loading exams…' : exams.length ? 'Choose an exam to monitor.' : 'You have no exams yet.'}
          </p>
        ) : loading ? (
          <div className="py-16 flex justify-center"><Loader2 className="animate-spin text-amber-500" /></div>
        ) : error ? (
          <div className="flex items-center gap-2 text-sm text-red-600"><AlertCircle size={16} /> {error}</div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600 dark:text-gray-400">
              <p><strong className="text-gray-900 dark:text-white">{inProgress}</strong> in progress · <strong className="text-gray-900 dark:text-white">{online}</strong> connected</p>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={showFinished} onChange={e => setShowFinished(e.target.checked)} className="accent-amber-600" />
                Show submitted sessions
              </label>
            </div>

            <div className="overflow-x-auto bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800">
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">
                  <tr className="[&>th]:px-3 [&>th]:py-3 [&>th]:font-medium [&>th]:text-left [&>th]:whitespace-nowrap">
                    <th>Student</th><th>Status</th><th>Cam</th><th>Mic</th><th>Face</th>
                    <th title="Multiple-person detections">People</th><th title="Phone / object detections">Objects</th>
                    <th title="Speech and loud-noise alerts">Audio</th><th title="Left the tab or window">Tab switches</th>
                    <th title="Face-not-visible events">Missing face</th><th>Total</th><th>Risk</th><th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {view.length === 0 && (
                    <tr><td colSpan={13} className="px-3 py-10 text-center text-gray-400">No students are taking this exam right now.</td></tr>
                  )}
                  {view.map(r => (
                    <tr key={r.id} className={`[&>td]:px-3 [&>td]:py-2.5 [&>td]:whitespace-nowrap ${r.needsReview ? 'bg-red-50/40 dark:bg-red-900/10' : ''}`}>
                      <td>
                        <p className="font-medium text-gray-900 dark:text-white">{r.name}</p>
                        <p className="text-xs text-gray-400">{r.studentNo}</p>
                      </td>
                      <td>
                        {r.examStatus !== 'in_progress' ? (
                          <span className="text-xs text-gray-500 capitalize">{r.examStatus.replace('_', ' ')}</span>
                        ) : r.online ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
                            <span className="w-2 h-2 rounded-full bg-green-500" />{r.away ? 'Away from tab' : 'Connected'}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs text-gray-500" title="No heartbeat — the exam page may be closed, backgrounded or offline">
                            <span className="w-2 h-2 rounded-full bg-gray-400" />No signal · {ago(r.lastSeenMs)}
                          </span>
                        )}
                      </td>
                      <td><Device state={r.camera} Ok={Camera} Bad={VideoOff} label="Camera" /></td>
                      <td><Device state={r.microphone} Ok={Mic} Bad={MicOff} label="Microphone" /></td>
                      <td>
                        {r.face === 'absent'
                          ? <span className="inline-flex text-red-500" title="Face not visible now"><EyeOff size={15} strokeWidth={1.75} /></span>
                          : r.face === 'present'
                            ? <span className="inline-flex text-green-600 dark:text-green-400" title="Face visible"><Eye size={15} strokeWidth={1.75} /></span>
                            : <span className="inline-flex text-gray-400" title={`Face check: ${r.face}`}><HelpCircle size={15} strokeWidth={1.75} /></span>}
                      </td>
                      <td><Count n={r.counts.multiplePeople} now={r.multiplePeopleNow} title="Multiple-person detections" /></td>
                      <td><Count n={r.counts.objects} title="Object detections" /></td>
                      <td><Count n={r.counts.audio} now={r.speakingNow} title="Audio alerts" /></td>
                      <td><Count n={r.counts.tabSwitches} now={r.online && r.away} title="Tab / window switches" /></td>
                      <td><Count n={r.counts.missingFace} title="Missing-face events" /></td>
                      <td><Count n={r.counts.total} title="All alerts" /></td>
                      <td>
                        <div className="flex items-center gap-1.5">
                          <RiskBadge score={r.score} level={r.level} />
                          <IdentityBadge flag={r.identityFlag} />
                          {r.needsReview && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-red-600 text-white" title="Meets the review threshold">Review</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <Link to={`/faculty/review/${r.id}?exam=${examId}`}
                          className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400 hover:underline">
                          Details <ArrowRight size={12} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-400">
              Camera, microphone and face status are reported by each student's browser every ~10 s. "No signal" means no
              report for 30 s. Counts are raw alerts; the risk score de-duplicates and weights them (see Details).
            </p>
          </>
        )}
      </div>
    </FacultyLayout>
  )
}
