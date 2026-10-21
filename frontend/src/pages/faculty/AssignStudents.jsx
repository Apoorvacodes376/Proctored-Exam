import { useState, useEffect } from 'react'
import { Search, UserCheck, UserX, Loader2, AlertCircle } from 'lucide-react'
import { supabase } from '../../lib/supabase'

export default function AssignStudents({ exam, facultyId, onDone }) {
  const [students, setStudents] = useState([])
  const [assigned, setAssigned] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState(new Set())
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      setLoading(true)
      const [{ data: allStudents }, { data: assignments }] = await Promise.all([
        supabase.from('students').select('id, name, email, student_id, photo_url').eq('faculty_id', facultyId),
        supabase.from('exam_assignments').select('student_id').eq('exam_id', exam.id),
      ])
      setStudents(allStudents || [])
      setAssigned(new Set(assignments?.map(a => a.student_id) || []))
      setLoading(false)
    }
    load()
  }, [exam.id, facultyId])

  async function toggle(student) {
    setError('')
    setToggling(t => new Set([...t, student.id]))
    try {
      if (assigned.has(student.id)) {
        const { error } = await supabase
          .from('exam_assignments')
          .delete()
          .eq('exam_id', exam.id)
          .eq('student_id', student.id)
        if (error) throw error
        setAssigned(a => { const n = new Set(a); n.delete(student.id); return n })
      } else {
        const { error } = await supabase
          .from('exam_assignments')
          .insert({ exam_id: exam.id, student_id: student.id })
        if (error) throw error
        setAssigned(a => new Set([...a, student.id]))
      }
      onDone()
    } catch (err) {
      setError(err.message || 'Failed to update assignment.')
    } finally {
      setToggling(t => { const n = new Set(t); n.delete(student.id); return n })
    }
  }

  const filtered = students.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.email.toLowerCase().includes(search.toLowerCase()) ||
    s.student_id.toLowerCase().includes(search.toLowerCase())
  )

  if (loading) return (
    <div className="flex items-center justify-center py-12">
      <Loader2 size={24} strokeWidth={1.75} className="text-amber-500 animate-spin" />
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {assigned.size} of {students.length} student{students.length !== 1 ? 's' : ''} assigned
        </p>
      </div>

      <div className="relative">
        <Search size={14} strokeWidth={1.75} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search students…"
          className="w-full pl-9 pr-4 py-2 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-500 transition" />
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-600 dark:text-red-400">
          <AlertCircle size={15} strokeWidth={1.75} className="shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {students.length === 0 ? (
        <div className="text-center py-8 text-sm text-gray-400">
          No students found. Add students in the Students section first.
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-8 text-sm text-gray-400">No students match your search.</div>
      ) : (
        <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
          {filtered.map(s => {
            const isAssigned = assigned.has(s.id)
            const isToggling = toggling.has(s.id)
            return (
              <div key={s.id}
                className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${
                  isAssigned
                    ? 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/10'
                    : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
                }`}>
                <div className="w-8 h-8 rounded-full overflow-hidden bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center shrink-0">
                  {s.photo_url
                    ? <img src={s.photo_url} alt={s.name} className="w-full h-full object-cover" />
                    : <span className="text-xs font-bold text-amber-700 dark:text-amber-400 uppercase">{s.name[0]}</span>
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{s.name}</p>
                  <p className="text-xs text-gray-400 truncate">{s.student_id} · {s.email}</p>
                </div>
                <button onClick={() => toggle(s)} disabled={isToggling}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 ${
                    isAssigned
                      ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/50'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 hover:text-amber-600 dark:hover:text-amber-400'
                  }`}>
                  {isToggling
                    ? <Loader2 size={12} strokeWidth={1.75} className="animate-spin" />
                    : isAssigned
                      ? <><UserX size={12} strokeWidth={1.75} /> Remove</>
                      : <><UserCheck size={12} strokeWidth={1.75} /> Assign</>
                  }
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
