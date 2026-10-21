import { useState, useEffect, useRef } from 'react'
import { Plus, Search, Pencil, Trash2, Upload, User, Loader2, AlertCircle, X, ChevronDown, ChevronUp } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import Modal from '../../components/Modal'
import ConfirmDialog from '../../components/ConfirmDialog'

const EMPTY_FORM = { name: '', email: '', student_id: '' }

function StudentForm({ initial, onSave, onCancel, saving, error }) {
  const [form, setForm] = useState(initial || EMPTY_FORM)
  const [photoFile, setPhotoFile] = useState(null)
  const [photoPreview, setPhotoPreview] = useState(initial?.photo_url || null)
  const fileRef = useRef()

  function handleChange(e) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }))
  }

  function handlePhoto(e) {
    const file = e.target.files[0]
    if (!file) return
    setPhotoFile(file)
    setPhotoPreview(URL.createObjectURL(file))
  }

  function removePhoto() {
    setPhotoFile(null)
    setPhotoPreview(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form, photoFile) }} className="space-y-4">
      {/* Photo */}
      <div className="flex items-center gap-4">
        <div className="w-20 h-20 rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-700 overflow-hidden flex items-center justify-center bg-gray-50 dark:bg-gray-800 shrink-0 relative">
          {photoPreview
            ? <img src={photoPreview} alt="Preview" className="w-full h-full object-cover" />
            : <User size={28} strokeWidth={1.5} className="text-gray-300 dark:text-gray-600" />
          }
        </div>
        <div className="space-y-2">
          <button type="button" onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium border border-gray-300 dark:border-gray-700 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            <Upload size={13} strokeWidth={1.75} /> Upload Photo
          </button>
          {photoPreview && (
            <button type="button" onClick={removePhoto}
              className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-600 transition-colors">
              <X size={12} strokeWidth={1.75} /> Remove
            </button>
          )}
          <p className="text-xs text-gray-400">JPG, PNG up to 2MB</p>
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handlePhoto} />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Full Name</label>
        <input name="name" value={form.name} onChange={handleChange} required placeholder="Jane Smith"
          className="w-full px-3 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 transition" />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
        <input name="email" type="email" value={form.email} onChange={handleChange} required placeholder="jane@university.edu"
          className="w-full px-3 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 transition" />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Student ID</label>
        <input name="student_id" value={form.student_id} onChange={handleChange} required placeholder="STU-2024-001"
          className="w-full px-3 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 transition" />
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-600 dark:text-red-400">
          <AlertCircle size={15} strokeWidth={1.75} className="shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      <div className="flex gap-3 pt-1">
        <button type="button" onClick={onCancel}
          className="flex-1 py-2.5 text-sm font-medium border border-gray-300 dark:border-gray-700 rounded-xl text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
          Cancel
        </button>
        <button type="submit" disabled={saving}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-xl transition-colors disabled:opacity-60">
          {saving && <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />}
          {initial ? 'Save Changes' : 'Add Student'}
        </button>
      </div>
    </form>
  )
}

function ExamGroupRow({ student }) {
  const [open, setOpen] = useState(false)
  const [exams, setExams] = useState([])
  const [loading, setLoading] = useState(false)

  async function loadExams() {
    if (open) { setOpen(false); return }
    setLoading(true)
    const { data } = await supabase
      .from('exam_assignments')
      .select('exam:exams(id, title, subject, exam_date, start_time)')
      .eq('student_id', student.id)
    setExams(data?.map(d => d.exam) || [])
    setLoading(false)
    setOpen(true)
  }

  return (
    <>
      <button onClick={loadExams}
        className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 hover:underline">
        {loading ? <Loader2 size={12} className="animate-spin" /> : open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        Exams
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {exams.length === 0
            ? <p className="text-xs text-gray-400">No exams assigned</p>
            : exams.map(e => (
              <div key={e.id} className="text-xs text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 rounded-lg px-2 py-1">
                {e.title} — {e.exam_date}
              </div>
            ))
          }
        </div>
      )}
    </>
  )
}

export default function StudentsPage() {
  const { profile } = useAuth()
  const [students, setStudents] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [formError, setFormError] = useState('')

  async function fetchStudents() {
    setLoading(true)
    const { data } = await supabase
      .from('students')
      .select('*')
      .eq('faculty_id', profile.id)
      .order('created_at', { ascending: false })
    setStudents(data || [])
    setLoading(false)
  }

  useEffect(() => { if (profile) fetchStudents() }, [profile])

  async function uploadPhoto(file, studentId) {
    const ext = file.name.split('.').pop()
    const path = `${profile.id}/${studentId}.${ext}`
    const { error } = await supabase.storage.from('student-photos').upload(path, file, { upsert: true })
    if (error) return null
    const { data } = supabase.storage.from('student-photos').getPublicUrl(path)
    return data.publicUrl
  }

  async function handleSave(form, photoFile) {
    setSaving(true)
    setFormError('')
    try {
      if (editing) {
        let photo_url = editing.photo_url
        if (photoFile) photo_url = await uploadPhoto(photoFile, editing.id) || photo_url

        const { error } = await supabase
          .from('students')
          .update({ name: form.name, email: form.email, student_id: form.student_id, photo_url })
          .eq('id', editing.id)
        if (error) throw error
      } else {
        const { data: inserted, error } = await supabase
          .from('students')
          .insert({ faculty_id: profile.id, name: form.name, email: form.email, student_id: form.student_id })
          .select()
          .single()
        if (error) throw error

        if (photoFile && inserted) {
          const photo_url = await uploadPhoto(photoFile, inserted.id)
          if (photo_url) await supabase.from('students').update({ photo_url }).eq('id', inserted.id)
        }
      }
      setModalOpen(false)
      setEditing(null)
      fetchStudents()
    } catch (err) {
      setFormError(err.message || 'Failed to save student.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    await supabase.from('students').delete().eq('id', deleteTarget.id)
    setDeleteTarget(null)
    setDeleting(false)
    fetchStudents()
  }

  function openAdd() { setEditing(null); setFormError(''); setModalOpen(true) }
  function openEdit(s) { setEditing(s); setFormError(''); setModalOpen(true) }

  const filtered = students.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.email.toLowerCase().includes(search.toLowerCase()) ||
    s.student_id.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="flex-1 p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Students</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{students.length} student{students.length !== 1 ? 's' : ''} registered</p>
        </div>
        <button onClick={openAdd}
          className="flex items-center gap-2 px-4 py-2.5 bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium rounded-xl transition-colors">
          <Plus size={16} strokeWidth={1.75} /> Add Student
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-5">
        <Search size={15} strokeWidth={1.75} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by name, email, or student ID…"
          className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-500 transition"
        />
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} strokeWidth={1.75} className="text-amber-500 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-12 h-12 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-400 mb-3">
              <User size={22} strokeWidth={1.5} />
            </div>
            <p className="text-sm font-medium text-gray-900 dark:text-white">
              {search ? 'No students match your search' : 'No students yet'}
            </p>
            <p className="text-xs text-gray-400 mt-1">
              {search ? 'Try a different search term' : 'Add your first student to get started'}
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800">
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Student</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">ID</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Email</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Exams</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {filtered.map(s => (
                <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full overflow-hidden bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center shrink-0">
                        {s.photo_url
                          ? <img src={s.photo_url} alt={s.name} className="w-full h-full object-cover" />
                          : <span className="text-xs font-bold text-amber-700 dark:text-amber-400 uppercase">{s.name[0]}</span>
                        }
                      </div>
                      <span className="font-medium text-gray-900 dark:text-white">{s.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-gray-500 dark:text-gray-400 font-mono text-xs">{s.student_id}</td>
                  <td className="px-5 py-3.5 text-gray-500 dark:text-gray-400">{s.email}</td>
                  <td className="px-5 py-3.5"><ExamGroupRow student={s} /></td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => openEdit(s)}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors">
                        <Pencil size={14} strokeWidth={1.75} />
                      </button>
                      <button onClick={() => setDeleteTarget(s)}
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

      {/* Add/Edit Modal */}
      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null) }}
        title={editing ? 'Edit Student' : 'Add Student'}
      >
        <StudentForm
          initial={editing}
          onSave={handleSave}
          onCancel={() => { setModalOpen(false); setEditing(null) }}
          saving={saving}
          error={formError}
        />
      </Modal>

      {/* Delete Confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        loading={deleting}
        title="Delete Student"
        message={`Remove "${deleteTarget?.name}" from your student list? This will also remove all exam assignments for this student.`}
      />
    </div>
  )
}
