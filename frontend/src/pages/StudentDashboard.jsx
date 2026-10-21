import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckSquare, CalendarClock, BarChart2, ClipboardList, LogOut, Clock, Calendar, Play } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useStudentRecord } from '../hooks/useStudentRecord'
import { supabase } from '../lib/supabase'
import ThemeToggle from '../components/ThemeToggle'

function examStatus(exam) {
  const start = new Date(`${exam.exam_date}T${exam.start_time}`)
  const end   = new Date(start.getTime() + exam.duration_mins * 60_000)
  const now   = new Date()
  if (now < start) return { label: 'Upcoming',    cls: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',   canStart: false }
  if (now <= end)  return { label: 'In Progress', cls: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400', canStart: true  }
  return               { label: 'Ended',       cls: 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400',        canStart: false }
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}
function formatTime(t) {
  const [h, m] = t.split(':')
  const d = new Date(); d.setHours(+h, +m)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export default function StudentDashboard() {
  const { profile, signOut }              = useAuth()
  const { student, loading: sLoading }    = useStudentRecord()
  const navigate                          = useNavigate()
  const [exams, setExams]                 = useState([])
  const [sessions, setSessions]           = useState({})   // { [examId]: session }
  const [loading, setLoading]             = useState(true)

  useEffect(() => {
    if (!student) return
    async function load() {
      const { data: assignments } = await supabase
        .from('exam_assignments')
        .select('exam:exams(id,title,subject,exam_date,start_time,duration_mins,total_marks)')
        .eq('student_id', student.id)

      const examList = (assignments?.map(a => a.exam).filter(Boolean) || [])
        .sort((a, b) => new Date(`${a.exam_date}T${a.start_time}`) - new Date(`${b.exam_date}T${b.start_time}`))
      setExams(examList)

      if (examList.length) {
        const { data: sess } = await supabase
          .from('exam_sessions')
          .select('exam_id,status,submitted_at')
          .eq('student_id', student.id)
          .in('exam_id', examList.map(e => e.id))
        const map = {}
        sess?.forEach(s => { map[s.exam_id] = s })
        setSessions(map)
      }
      setLoading(false)
    }
    load()
  }, [student])

  const now      = new Date()
  const taken    = exams.filter(e => sessions[e.id]?.status === 'submitted' || sessions[e.id]?.status === 'timed_out').length
  const upcoming = exams.filter(e => new Date(`${e.exam_date}T${e.start_time}`) > now).length

  const stats = [
    { label: 'Exams Taken',    value: taken,          icon: CheckSquare  },
    { label: 'Upcoming Exams', value: upcoming,        icon: CalendarClock },
    { label: 'Total Assigned', value: exams.length,    icon: BarChart2    },
  ]

  const isLoading = loading || sLoading

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors">
      <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl font-bold text-green-600 dark:text-green-400">ProctorAI</span>
            <span className="px-2 py-0.5 text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full">Student</span>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button onClick={signOut}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
              <LogOut size={15} strokeWidth={1.75} /> Sign Out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Welcome back, {profile?.username || 'Student'}
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">Here's your exam overview.</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          {stats.map(({ label, value, icon: Icon }) => (
            <div key={label} className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
                <div className="w-8 h-8 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center text-green-600 dark:text-green-400">
                  <Icon size={16} strokeWidth={1.75} />
                </div>
              </div>
              <p className="text-3xl font-bold text-green-600 dark:text-green-400">{isLoading ? '—' : value}</p>
            </div>
          ))}
        </div>

        {/* Exam list */}
        {isLoading ? (
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-12 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : exams.length === 0 ? (
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-12 flex flex-col items-center justify-center text-center">
            <div className="w-12 h-12 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-400 dark:text-gray-500 mb-4">
              <ClipboardList size={24} strokeWidth={1.5} />
            </div>
            <h3 className="font-semibold text-gray-900 dark:text-white mb-1">No exams assigned</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">Your scheduled exams will appear here once assigned by your faculty.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Your Exams</h2>
            {exams.map(exam => {
              const sess   = sessions[exam.id]
              const done   = sess?.status === 'submitted' || sess?.status === 'timed_out'
              const active = sess?.status === 'in_progress'
              const status = done
                ? { label: 'Submitted', cls: 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400', canStart: false }
                : examStatus(exam)

              return (
                <div key={exam.id} className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-5 flex items-center gap-5">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <p className="font-semibold text-gray-900 dark:text-white">{exam.title}</p>
                      <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${status.cls}`}>{status.label}</span>
                    </div>
                    <p className="text-sm text-gray-500 dark:text-gray-400">{exam.subject}</p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-gray-400 flex-wrap">
                      <span className="flex items-center gap-1"><Calendar size={12} strokeWidth={1.75} />{formatDate(exam.exam_date)}</span>
                      <span className="flex items-center gap-1"><Clock size={12} strokeWidth={1.75} />{formatTime(exam.start_time)} · {exam.duration_mins} min</span>
                    </div>
                  </div>

                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <div className="text-right">
                      <p className="text-lg font-bold text-green-600 dark:text-green-400">{exam.total_marks}</p>
                      <p className="text-xs text-gray-400">marks</p>
                    </div>
                    {(status.canStart || active) && !done && (
                      <button
                        onClick={() => navigate(`/student/exam/${exam.id}`)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-semibold rounded-lg transition-colors"
                      >
                        <Play size={11} strokeWidth={2} />
                        {active ? 'Resume' : 'Start Exam'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
