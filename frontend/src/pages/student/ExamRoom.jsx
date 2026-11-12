import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Loader2, ChevronLeft, ChevronRight, AlertCircle, Send, ShieldCheck, CheckCircle2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useStudentRecord } from '../../hooks/useStudentRecord'
import { useProctoring } from '../../hooks/useProctoring'
import ExamTimer from '../../components/ExamTimer'
import VerificationGate from '../../components/VerificationGate'
import ConfirmDialog from '../../components/ConfirmDialog'
import ProctoringOverlay from '../../components/ProctoringOverlay'

const AUTOSAVE_MS = 15_000

function getWindow(exam) {
  const start = new Date(`${exam.exam_date}T${exam.start_time}`)
  const end   = new Date(start.getTime() + exam.duration_mins * 60_000)
  return { start, end }
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-6">
      {children}
    </div>
  )
}

function MonitoringConsent({ onContinue }) {
  return (
    <div className="space-y-4 text-sm text-gray-600 dark:text-gray-300">
      <div className="flex items-start gap-2 px-3 py-2.5 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl">
        <ShieldCheck size={16} strokeWidth={1.75} className="shrink-0 mt-0.5 text-green-600 dark:text-green-400" />
        <p>This is a proctored exam. Your browser will ask for <strong>camera and microphone</strong> access when you continue.</p>
      </div>
      <div className="space-y-1.5">
        <p className="font-semibold text-gray-900 dark:text-white">While the exam is running we monitor:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>that your face is visible and you are alone in view;</li>
          <li>phones and books visible to the webcam;</li>
          <li>sustained speech and loud noise (analysed on your device, not recorded);</li>
          <li>your camera and microphone staying on;</li>
          <li>leaving the exam tab or window.</li>
        </ul>
        <p>A webcam snapshot is saved only when an alert occurs, and only your faculty can see it. A "Monitoring active" panel stays on screen throughout.</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          A browser cannot detect other devices, other applications or anything outside the camera's view, and alerts can be wrong — every alert is reviewed by a person.
        </p>
      </div>
      <button onClick={onContinue}
        className="w-full py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-xl transition-colors">
        I understand — continue
      </button>
    </div>
  )
}

function QuestionNav({ questions, current, answers, onSelect }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {questions.map((q, i) => {
        const answered = !!answers[q.id]?.trim()
        const active   = i === current
        return (
          <button
            key={q.id}
            onClick={() => onSelect(i)}
            className={`w-8 h-8 rounded-lg text-xs font-semibold transition-colors ${
              active
                ? 'bg-green-600 text-white'
                : answered
                  ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            {i + 1}
          </button>
        )
      })}
    </div>
  )
}

export default function ExamRoom() {
  const { examId }  = useParams()
  const navigate    = useNavigate()
  const { profile } = useAuth()
  const { student, loading: studentLoading } = useStudentRecord()

  // phase: 'loading' | 'outside_window' | 'verify' | 'exam' | 'submitted' | 'manual_review'
  const [phase, setPhase]           = useState('loading')
  const [exam, setExam]             = useState(null)
  const [questions, setQuestions]   = useState([])
  const [session, setSession]       = useState(null)
  const [answers, setAnswers]       = useState({})
  const [current, setCurrent]       = useState(0)
  const [saving, setSaving]         = useState(false)
  const [saveError, setSaveError]   = useState('')
  const [submitOpen, setSubmitOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [loadError, setLoadError]   = useState('')

  // Stream passed from VerificationGate → kept alive for monitoring.
  const [liveStream, setLiveStream] = useState(null)
  // Student has read what is monitored before the browser asks for camera/mic.
  const [consented, setConsented] = useState(false)

  const endsAtRef    = useRef(null)
  const dirtyRef     = useRef(false)
  const submitLock   = useRef(false)
  // Hidden video element used by monitoring modules during the exam.
  const monitorVideoRef = useRef(null)

  // ── Proctoring ────────────────────────────────────────────
  const { status: procStatus, dismissAlert } = useProctoring({
    examSessionId:  session?.id ?? null,
    examId:         exam?.id ?? null,
    studentId:      student?.id ?? null,
    active:         phase === 'exam',
    existingStream: liveStream,
    videoRef:       monitorVideoRef,
  })

  // ── Load exam + check window ──────────────────────────────
  useEffect(() => {
    if (!profile || studentLoading) return
    if (!student) { setLoadError('No student record found for your account.'); return }

    async function load() {
      const { data: assignment } = await supabase
        .from('exam_assignments')
        .select('id, exam:exams(id,title,subject,exam_date,start_time,duration_mins,total_marks,instructions)')
        .eq('exam_id', examId)
        .eq('student_id', student.id)
        .maybeSingle()

      if (!assignment) { setLoadError('You are not assigned to this exam.'); return }

      const examData = assignment.exam
      setExam({ ...examData, assignment_id: assignment.id })

      const { start, end } = getWindow(examData)
      const now = new Date()
      if (now < start || now > end) { setPhase('outside_window'); return }

      // Served without the answer key (Phase 6); see get_exam_questions().
      const { data: qs, error: qErr } = await supabase.rpc('get_exam_questions', { p_exam_id: examId })
      if (qErr) throw qErr
      setQuestions(qs || [])

      const { data: existing } = await supabase
        .from('exam_sessions')
        .select('*')
        .eq('exam_id', examId)
        .eq('student_id', student.id)
        .maybeSingle()

      if (existing?.status === 'submitted' || existing?.status === 'timed_out') {
        setSession(existing); setPhase('submitted'); return
      }

      if (existing) {
        setSession(existing)
        const { data: saved } = await supabase
          .from('exam_answers')
          .select('question_id,answer_text')
          .eq('session_id', existing.id)
        const map = {}
        saved?.forEach(a => { map[a.question_id] = a.answer_text ?? '' })
        setAnswers(map)
        endsAtRef.current = new Date(existing.started_at).getTime() + examData.duration_mins * 60_000
        setPhase('exam'); return
      }

      setPhase('verify')
    }

    load().catch(err => setLoadError(err.message))
  }, [profile, student, studentLoading, examId])

  // Attach stream to hidden monitoring video when stream + ref are ready.
  useEffect(() => {
    if (liveStream && monitorVideoRef.current && !monitorVideoRef.current.srcObject) {
      monitorVideoRef.current.srcObject = liveStream
    }
  }, [liveStream, phase])

  // Stop stream when exam ends (submitted / timed_out).
  useEffect(() => {
    if (phase === 'submitted' || phase === 'manual_review') {
      liveStream?.getTracks().forEach(t => t.stop())
    }
  }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Identity verification log (Phase 5) ─────────────────
  // Kept separate from behavioural proctoring events. Insert-only: students
  // cannot read these rows back.
  const logIdentity = useCallback(async ({ result, distance = null, threshold = null }) => {
    if (!exam?.id || !student?.id) return
    const round = x => (x === null || x === undefined ? null : Math.round(x * 10_000) / 10_000)
    const { error } = await supabase.from('identity_verifications').insert({
      exam_id: exam.id, student_id: student.id, result, distance: round(distance), threshold: round(threshold),
    })
    if (error) console.warn('[ExamRoom] could not log identity verification:', error.message)
  }, [exam?.id, student?.id])

  function requestManualReview(result = 'manual_review_requested') {
    logIdentity({ result })
    setPhase('manual_review')
  }

  // ── Create session after verification ────────────────────
  async function handleVerified(stream) {
    // stream is passed from VerificationGate after it stops its own tracks.
    // We request a fresh stream here for monitoring (VerificationGate stops
    // its stream before calling onVerified).
    let monitorStream = stream
    if (!monitorStream) {
      try {
        monitorStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      } catch {
        // Monitoring will be degraded but exam can still proceed.
      }
    }
    setLiveStream(monitorStream ?? null)

    const { data: newSession, error } = await supabase
      .from('exam_sessions')
      .insert({
        exam_id:       examId,
        student_id:    student.id,
        assignment_id: exam.assignment_id,
        status:        'in_progress',
        user_agent:    navigator.userAgent,
      })
      .select()
      .single()
    if (error) { setLoadError(error.message); return }
    setSession(newSession)
    endsAtRef.current = new Date(newSession.started_at).getTime() + exam.duration_mins * 60_000
    setPhase('exam')
  }

  // ── Save answers ──────────────────────────────────────────
  const saveAnswers = useCallback(async (snap, sessionId, force = false) => {
    if (!sessionId || (!dirtyRef.current && !force)) return
    setSaving(true)
    const upserts = Object.entries(snap)
      .map(([question_id, answer_text]) => ({ session_id: sessionId, question_id, answer_text: answer_text ?? '' }))
    if (upserts.length) {
      // The server refuses changes after submission or once time is up.
      const { error } = await supabase.from('exam_answers').upsert(upserts, { onConflict: 'session_id,question_id' })
      setSaveError(error ? error.message : '')
      if (error) { setSaving(false); return }
    }
    dirtyRef.current = false
    setSaving(false)
  }, [])

  useEffect(() => {
    if (phase !== 'exam' || !session) return
    const id = setInterval(() => saveAnswers(answers, session.id), AUTOSAVE_MS)
    return () => clearInterval(id)
  }, [phase, session, answers, saveAnswers])

  function setAnswer(questionId, value) {
    setAnswers(prev => ({ ...prev, [questionId]: value }))
    dirtyRef.current = true
  }

  // ── Submit ────────────────────────────────────────────────
  const doSubmit = useCallback(async (reason = 'submitted') => {
    if (!session || submitLock.current) return
    submitLock.current = true
    setSubmitting(true)
    await saveAnswers(answers, session.id, true)
    await supabase
      .from('exam_sessions')
      .update({ status: reason, submitted_at: new Date().toISOString() })
      .eq('id', session.id)
    await supabase.rpc('auto_grade_session', { p_session_id: session.id })
    setSubmitting(false)
    setSubmitOpen(false)
    setPhase('submitted')
  }, [session, answers, saveAnswers])

  const handleTimerExpire = useCallback(() => doSubmit('timed_out'), [doSubmit])

  // ── Render: loading / error ───────────────────────────────
  if (phase === 'loading' || studentLoading) {
    return (
      <Shell>
        {loadError
          ? <div className="text-center space-y-3">
              <AlertCircle size={32} strokeWidth={1.5} className="text-red-500 mx-auto" />
              <p className="text-sm text-gray-600 dark:text-gray-400">{loadError}</p>
              <button onClick={() => navigate('/student')} className="text-sm text-green-600 dark:text-green-400 hover:underline">← Back to Dashboard</button>
            </div>
          : <Loader2 size={32} strokeWidth={1.75} className="text-green-500 animate-spin" />
        }
      </Shell>
    )
  }

  // ── Render: outside window ────────────────────────────────
  if (phase === 'outside_window') {
    const { start, end } = getWindow(exam)
    const now = new Date()
    return (
      <Shell>
        <div className="text-center space-y-3 max-w-sm">
          <AlertCircle size={32} strokeWidth={1.5} className="text-amber-500 mx-auto" />
          <p className="font-semibold text-gray-900 dark:text-white">{exam.title}</p>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {now < start
              ? `This exam opens at ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} on ${start.toLocaleDateString()}.`
              : `This exam closed at ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`}
          </p>
          <button onClick={() => navigate('/student')} className="text-sm text-green-600 dark:text-green-400 hover:underline">← Back to Dashboard</button>
        </div>
      </Shell>
    )
  }

  // ── Render: submitted ─────────────────────────────────────
  if (phase === 'submitted') {
    return (
      <Shell>
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto">
            <CheckCircle2 size={36} strokeWidth={1.5} className="text-green-600 dark:text-green-400" />
          </div>
          <p className="text-xl font-bold text-gray-900 dark:text-white">Exam Submitted</p>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {exam?.title} has been submitted. Your faculty will review the results.
          </p>
          <button onClick={() => navigate('/student')}
            className="mt-2 px-6 py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-xl transition-colors">
            Back to Dashboard
          </button>
        </div>
      </Shell>
    )
  }

  // ── Render: manual review ─────────────────────────────────
  if (phase === 'manual_review') {
    return (
      <Shell>
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto">
            <ShieldCheck size={36} strokeWidth={1.5} className="text-amber-600 dark:text-amber-400" />
          </div>
          <p className="text-xl font-bold text-gray-900 dark:text-white">Manual Review Requested</p>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Your identity could not be verified automatically. Your faculty has been notified and will review your case.
          </p>
          <button onClick={() => navigate('/student')} className="text-sm text-green-600 dark:text-green-400 hover:underline">← Back to Dashboard</button>
        </div>
      </Shell>
    )
  }

  // ── Render: verification gate ─────────────────────────────
  if (phase === 'verify') {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 shadow-xl">
          <div className="mb-5">
            <p className="text-xs font-semibold text-green-600 dark:text-green-400 uppercase tracking-wide mb-1">Identity Verification</p>
            <h1 className="text-lg font-bold text-gray-900 dark:text-white">{exam?.title}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{exam?.subject}</p>
          </div>
          {!consented
            ? <MonitoringConsent onContinue={() => setConsented(true)} />
            : student?.photo_url
            ? <VerificationGate
                referencePhotoUrl={student.photo_url}
                onVerified={handleVerified}
                onManualReview={() => requestManualReview()}
                onAttempt={logIdentity}
              />
            : <div className="space-y-4 py-4">
                <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl text-sm text-amber-700 dark:text-amber-400">
                  <AlertCircle size={15} strokeWidth={1.75} className="shrink-0 mt-0.5" />
                  No reference photograph on file. Your faculty must upload one before identity verification can proceed.
                </div>
                <button onClick={() => requestManualReview('no_reference_photo')}
                  className="w-full py-2.5 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-xl transition-colors">
                  Request Manual Review
                </button>
              </div>
          }
        </div>
      </div>
    )
  }

  // ── Render: exam interface ────────────────────────────────
  const q = questions[current]
  const answeredCount = Object.values(answers).filter(v => v?.trim()).length

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col">
      {/* Top bar */}
      <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-6 py-3 flex items-center justify-between shrink-0">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 dark:text-white truncate">{exam?.title}</p>
          <p className="text-xs text-gray-400 truncate">{exam?.subject}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-gray-500 dark:text-gray-400 hidden sm:inline">
            {answeredCount}/{questions.length} answered
          </span>
          {saving && (
            <span className="text-xs text-gray-400 flex items-center gap-1">
              <Loader2 size={11} className="animate-spin" /> Saving…
            </span>
          )}
          {!saving && saveError && (
            <span className="text-xs text-red-600 dark:text-red-400 max-w-[16rem] truncate" title={saveError} role="alert">
              Not saved: {saveError}
            </span>
          )}
          {endsAtRef.current && (
            <ExamTimer endsAt={endsAtRef.current} onExpire={handleTimerExpire} />
          )}
        </div>
      </header>

      <div className="flex flex-1 min-h-0 w-full max-w-5xl mx-auto">
        {/* Question panel */}
        <main className="flex-1 p-6 overflow-y-auto">
          {q ? (
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 space-y-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-2 py-0.5 rounded-md">
                    Q{current + 1} of {questions.length}
                  </span>
                  <span className="text-xs text-gray-400">
                    {q.question_type === 'mcq' ? 'Multiple Choice' : 'Descriptive'}
                  </span>
                </div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">
                  {q.marks} mark{q.marks !== 1 ? 's' : ''}
                </span>
              </div>

              <p className="text-gray-900 dark:text-white leading-relaxed">{q.question_text}</p>

              {/* MCQ */}
              {q.question_type === 'mcq' && Array.isArray(q.options) && (
                <div className="space-y-2">
                  {q.options.map((opt, i) => {
                    const selected = answers[q.id] === String(i)
                    return (
                      <button key={i} onClick={() => setAnswer(q.id, String(i))}
                        className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left text-sm transition-colors ${
                          selected
                            ? 'border-green-500 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
                            : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-green-300 dark:hover:border-green-700'
                        }`}>
                        <span className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 text-xs font-bold transition-colors ${
                          selected ? 'border-green-500 bg-green-500 text-white' : 'border-gray-300 dark:border-gray-600'
                        }`}>
                          {String.fromCharCode(65 + i)}
                        </span>
                        {opt}
                      </button>
                    )
                  })}
                </div>
              )}

              {/* Descriptive */}
              {q.question_type === 'descriptive' && (
                <textarea
                  value={answers[q.id] ?? ''}
                  onChange={e => setAnswer(q.id, e.target.value)}
                  rows={7}
                  placeholder="Type your answer here…"
                  className="w-full px-4 py-3 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none transition"
                />
              )}

              {/* Navigation */}
              <div className="flex items-center justify-between pt-2">
                <button
                  onClick={() => setCurrent(c => Math.max(0, c - 1))}
                  disabled={current === 0}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium border border-gray-300 dark:border-gray-700 rounded-xl text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 transition-colors"
                >
                  <ChevronLeft size={15} strokeWidth={1.75} /> Previous
                </button>
                {current < questions.length - 1 ? (
                  <button onClick={() => setCurrent(c => c + 1)}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-green-600 hover:bg-green-700 text-white rounded-xl transition-colors">
                    Next <ChevronRight size={15} strokeWidth={1.75} />
                  </button>
                ) : (
                  <button onClick={() => setSubmitOpen(true)}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-green-600 hover:bg-green-700 text-white rounded-xl transition-colors">
                    <Send size={14} strokeWidth={1.75} /> Submit Exam
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="text-center py-16 text-gray-400 text-sm">No questions found for this exam.</div>
          )}
        </main>

        {/* Sidebar */}
        <aside className="w-52 shrink-0 p-4 border-l border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-y-auto hidden sm:flex flex-col">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">Questions</p>
          <QuestionNav questions={questions} current={current} answers={answers} onSelect={setCurrent} />
          <div className="mt-4 space-y-1.5 text-xs text-gray-400">
            <p><span className="inline-block w-3 h-3 rounded bg-green-100 dark:bg-green-900/30 mr-1.5 align-middle" />Answered</p>
            <p><span className="inline-block w-3 h-3 rounded bg-gray-100 dark:bg-gray-800 mr-1.5 align-middle" />Unanswered</p>
          </div>
          <button onClick={() => setSubmitOpen(true)}
            className="mt-auto w-full flex items-center justify-center gap-1.5 py-2 text-xs font-semibold bg-green-600 hover:bg-green-700 text-white rounded-xl transition-colors">
            <Send size={12} strokeWidth={1.75} /> Submit
          </button>
        </aside>
      </div>

      {/* Proctoring overlay — fixed bottom-right; shows the webcam self-view
          that the monitoring modules also read from. */}
      <ProctoringOverlay status={procStatus} onDismiss={dismissAlert} videoRef={monitorVideoRef} />

      <ConfirmDialog
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        onConfirm={() => doSubmit('submitted')}
        loading={submitting}
        title="Submit Exam"
        message={`You have answered ${answeredCount} of ${questions.length} questions. Once submitted you cannot make changes. Are you sure?`}
      />
    </div>
  )
}
