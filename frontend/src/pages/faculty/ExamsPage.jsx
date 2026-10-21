import { useState, useEffect } from 'react'
import { Plus, Search, Pencil, Trash2, Loader2, AlertCircle, Users, FileText, Clock, Calendar, ChevronRight } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import Modal from '../../components/Modal'
import ConfirmDialog from '../../components/ConfirmDialog'
import ExamForm from './ExamForm'
import QuestionsEditor from './QuestionsEditor'
import AssignStudents from './AssignStudents'

const TABS = ['details', 'questions', 'students']

export default function ExamsPage() {
  const { profile } = useAuth()
  const [exams, setExams] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [activeExam, setActiveExam] = useState(null)
  const [activeTab, setActiveTab] = useState('details')
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)

  async function fetchExams() {
    setLoading(true)
    const { data } = await supabase
      .from('exams')
      .select('*, questions(count), exam_assignments(count)')
      .eq('faculty_id', profile.id)
      .order('exam_date', { ascending: true })
    setExams(data || [])
    setLoading(false)
  }

  useEffect(() => { if (profile) fetchExams() }, [profile])

  function openCreate() {
    setActiveExam(null)
    setActiveTab('details')
    setModalOpen(true)
  }

  function openEdit(exam) {
    setActiveExam(exam)
    setActiveTab('details')
    setModalOpen(true)
  }

  function openTab(exam, tab) {
    setActiveExam(exam)
    setActiveTab(tab)
    setModalOpen(true)
  }

  async function handleDelete() {
    setDeleting(true)
    await supabase.from('exams').delete().eq('id', deleteTarget.id)
    setDeleteTarget(null)
    setDeleting(false)
    fetchExams()
  }

  function handleExamSaved(exam) {
    setActiveExam(exam)
    setActiveTab('questions')
    fetchExams()
  }

  const filtered = exams.filter(e =>
    e.title.toLowerCase().includes(search.toLowerCase()) ||
    e.subject.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="flex-1 p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Exams</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{exams.length} exam{exams.length !== 1 ? 's' : ''} created</p>
        </div>
        <button onClick={openCreate}
          className="flex items-center gap-2 px-4 py-2.5 bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium rounded-xl transition-colors">
          <Plus size={16} strokeWidth={1.75} /> Create Exam
        </button>
      </div>

      <div className="relative mb-5">
        <Search size={15} strokeWidth={1.75} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by title or subject…"
          className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-500 transition"
        />
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} strokeWidth={1.75} className="text-amber-500 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-12 h-12 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-400 mb-3">
              <FileText size={22} strokeWidth={1.5} />
            </div>
            <p className="text-sm font-medium text-gray-900 dark:text-white">
              {search ? 'No exams match your search' : 'No exams yet'}
            </p>
            <p className="text-xs text-gray-400 mt-1">
              {search ? 'Try a different search term' : 'Create your first exam to get started'}
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800">
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Exam</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Date & Time</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Duration</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Marks</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Q / Students</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {filtered.map(exam => (
                <tr key={exam.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td className="px-5 py-3.5">
                    <p className="font-medium text-gray-900 dark:text-white">{exam.title}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{exam.subject}</p>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400">
                      <Calendar size={13} strokeWidth={1.75} />
                      <span>{exam.exam_date}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-gray-400 mt-0.5">
                      <Clock size={13} strokeWidth={1.75} />
                      <span>{exam.start_time?.slice(0, 5)}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-gray-500 dark:text-gray-400">{exam.duration_mins} min</td>
                  <td className="px-5 py-3.5 text-gray-500 dark:text-gray-400">{exam.total_marks}</td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <button onClick={() => openTab(exam, 'questions')}
                        className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 hover:underline">
                        <FileText size={12} strokeWidth={1.75} />
                        {exam.questions?.[0]?.count ?? 0} Q
                      </button>
                      <button onClick={() => openTab(exam, 'students')}
                        className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 hover:underline">
                        <Users size={12} strokeWidth={1.75} />
                        {exam.exam_assignments?.[0]?.count ?? 0} students
                      </button>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => openEdit(exam)}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors">
                        <Pencil size={14} strokeWidth={1.75} />
                      </button>
                      <button onClick={() => setDeleteTarget(exam)}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                        <Trash2 size={14} strokeWidth={1.75} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Exam Modal with tabs */}
      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setActiveExam(null) }}
        title={activeExam ? activeExam.title : 'Create Exam'}
        maxWidth="max-w-2xl"
      >
        {/* Tabs — only show after exam exists */}
        {activeExam && (
          <div className="flex gap-1 mb-5 p-1 bg-gray-100 dark:bg-gray-800 rounded-xl">
            {TABS.map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`flex-1 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${
                  activeTab === tab
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}>
                {tab === 'details' ? 'Details' : tab === 'questions' ? 'Questions' : 'Assign Students'}
              </button>
            ))}
          </div>
        )}

        {activeTab === 'details' && (
          <ExamForm
            initial={activeExam}
            facultyId={profile?.id}
            onSaved={handleExamSaved}
            onCancel={() => { setModalOpen(false); setActiveExam(null) }}
          />
        )}
        {activeTab === 'questions' && activeExam && (
          <QuestionsEditor exam={activeExam} onDone={fetchExams} />
        )}
        {activeTab === 'students' && activeExam && (
          <AssignStudents exam={activeExam} facultyId={profile?.id} onDone={fetchExams} />
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        loading={deleting}
        title="Delete Exam"
        message={`Delete "${deleteTarget?.title}"? All questions and student assignments will be permanently removed.`}
      />
    </div>
  )
}
