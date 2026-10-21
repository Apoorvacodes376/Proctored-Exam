import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { FilePlus2, Users, ClipboardCheck, ArrowRight } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import FacultyLayout from '../components/FacultyLayout'

export default function FacultyDashboard() {
  const { profile } = useAuth()
  const [stats, setStats] = useState({ exams: 0, students: 0, assignments: 0 })

  useEffect(() => {
    if (!profile) return
    async function loadStats() {
      const [{ count: exams }, { count: students }] = await Promise.all([
        supabase.from('exams').select('*', { count: 'exact', head: true }).eq('faculty_id', profile.id),
        supabase.from('students').select('*', { count: 'exact', head: true }).eq('faculty_id', profile.id),
      ])
      // Count assignments via exams owned by this faculty
      const { data: examIds } = await supabase.from('exams').select('id').eq('faculty_id', profile.id)
      let assignments = 0
      if (examIds?.length) {
        const { count } = await supabase
          .from('exam_assignments')
          .select('*', { count: 'exact', head: true })
          .in('exam_id', examIds.map(e => e.id))
        assignments = count || 0
      }
      setStats({ exams: exams || 0, students: students || 0, assignments })
    }
    loadStats()
  }, [profile])

  const statCards = [
    { label: 'Exams Created',   value: stats.exams,       icon: FilePlus2,      to: '/faculty/exams'    },
    { label: 'Students',        value: stats.students,    icon: Users,          to: '/faculty/students' },
    { label: 'Assignments',     value: stats.assignments, icon: ClipboardCheck, to: null                },
  ]

  return (
    <FacultyLayout>
      <div className="p-8">
        <div className="mb-8">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">
            Welcome, {profile?.username || 'Faculty'}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Manage your exams and monitor students.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          {statCards.map(({ label, value, icon: Icon, to }) => (
            <div key={label} className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
                <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center text-amber-600 dark:text-amber-400">
                  <Icon size={16} strokeWidth={1.75} />
                </div>
              </div>
              <p className="text-3xl font-bold text-amber-600 dark:text-amber-400">{value}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
            <div className="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center text-amber-600 dark:text-amber-400 mb-4">
              <FilePlus2 size={20} strokeWidth={1.75} />
            </div>
            <h3 className="font-semibold text-gray-900 dark:text-white mb-1">Manage Exams</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Create exams, add questions, and assign students.</p>
            <Link to="/faculty/exams"
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium rounded-lg transition-colors">
              Go to Exams <ArrowRight size={14} strokeWidth={1.75} />
            </Link>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
            <div className="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center text-amber-600 dark:text-amber-400 mb-4">
              <Users size={20} strokeWidth={1.75} />
            </div>
            <h3 className="font-semibold text-gray-900 dark:text-white mb-1">Manage Students</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Add student records, upload photos, and assign exams.</p>
            <Link to="/faculty/students"
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium rounded-lg transition-colors">
              Go to Students <ArrowRight size={14} strokeWidth={1.75} />
            </Link>
          </div>
        </div>
      </div>
    </FacultyLayout>
  )
}
