import { useState } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { supabase } from '../../lib/supabase'

// Exam times are entered in the faculty member's local time; the zone is
// stored so the server can enforce the window (Phase 6).
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || null

const EMPTY = {
  title: '', subject: '', exam_date: '', start_time: '',
  duration_mins: 60, total_marks: 100, instructions: '',
}

export default function ExamForm({ initial, facultyId, onSaved, onCancel }) {
  const [form, setForm] = useState(initial ? {
    title: initial.title,
    subject: initial.subject,
    exam_date: initial.exam_date,
    start_time: initial.start_time?.slice(0, 5) || '',
    duration_mins: initial.duration_mins,
    total_marks: initial.total_marks,
    instructions: initial.instructions || '',
    time_zone: initial.time_zone || BROWSER_TZ,
  } : { ...EMPTY, time_zone: BROWSER_TZ })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function handleChange(e) {
    const { name, value } = e.target
    setForm(f => ({ ...f, [name]: name === 'duration_mins' || name === 'total_marks' ? Number(value) : value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      if (initial) {
        const { data, error: err } = await supabase
          .from('exams').update(form).eq('id', initial.id).select().single()
        if (err) throw err
        onSaved(data)
      } else {
        const { data, error: err } = await supabase
          .from('exams').insert({ ...form, faculty_id: facultyId }).select().single()
        if (err) throw err
        onSaved(data)
      }
    } catch (err) {
      setError(err.message || 'Failed to save exam.')
    } finally {
      setSaving(false)
    }
  }

  const inputCls = "w-full px-3 py-2.5 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 transition"

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Exam Title</label>
          <input name="title" value={form.title} onChange={handleChange} required placeholder="Midterm Examination" className={inputCls} />
        </div>
        <div className="col-span-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Subject</label>
          <input name="subject" value={form.subject} onChange={handleChange} required placeholder="Computer Science" className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Exam Date</label>
          <input name="exam_date" type="date" value={form.exam_date} onChange={handleChange} required className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Start Time</label>
          <input name="start_time" type="time" value={form.start_time} onChange={handleChange} required className={inputCls} />
          {form.time_zone && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Time zone: {form.time_zone}. Students can start only inside this window.
            </p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Duration (minutes)</label>
          <input name="duration_mins" type="number" min="1" value={form.duration_mins} onChange={handleChange} required className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Total Marks</label>
          <input name="total_marks" type="number" min="1" value={form.total_marks} onChange={handleChange} required className={inputCls} />
        </div>
        <div className="col-span-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Instructions <span className="text-gray-400 font-normal">(optional)</span></label>
          <textarea name="instructions" value={form.instructions} onChange={handleChange} rows={3}
            placeholder="Any special instructions for students…"
            className={`${inputCls} resize-none`} />
        </div>
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
          {initial ? 'Save Changes' : 'Create & Add Questions'}
        </button>
      </div>
    </form>
  )
}
