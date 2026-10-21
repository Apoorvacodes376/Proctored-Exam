import { useState, useEffect } from 'react'
import { Plus, Trash2, Loader2, AlertCircle, GripVertical, CheckCircle2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'

const EMPTY_Q = { question_text: '', question_type: 'mcq', options: ['', '', '', ''], correct_answer: '0', marks: 1 }

function QuestionCard({ q, index, onUpdate, onDelete }) {
  function setField(field, value) {
    onUpdate({ ...q, [field]: value })
  }
  function setOption(i, value) {
    const opts = [...q.options]
    opts[i] = value
    onUpdate({ ...q, options: opts })
  }

  const inputCls = "w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 transition"

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-4 space-y-3 bg-gray-50 dark:bg-gray-800/50">
      <div className="flex items-start gap-3">
        <GripVertical size={16} strokeWidth={1.75} className="text-gray-300 dark:text-gray-600 mt-2.5 shrink-0" />
        <div className="flex-1 space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 rounded-md">Q{index + 1}</span>
            <select value={q.question_type} onChange={e => setField('question_type', e.target.value)}
              className="text-xs border border-gray-300 dark:border-gray-700 rounded-lg px-2 py-1 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-amber-500">
              <option value="mcq">Multiple Choice</option>
              <option value="descriptive">Descriptive</option>
            </select>
            <div className="flex items-center gap-1.5 ml-auto">
              <label className="text-xs text-gray-500 dark:text-gray-400">Marks:</label>
              <input type="number" min="1" value={q.marks} onChange={e => setField('marks', Number(e.target.value))}
                className="w-16 px-2 py-1 text-xs rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500" />
            </div>
            <button onClick={onDelete}
              className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
              <Trash2 size={14} strokeWidth={1.75} />
            </button>
          </div>

          <textarea value={q.question_text} onChange={e => setField('question_text', e.target.value)}
            placeholder="Enter question text…" rows={2}
            className={`${inputCls} resize-none`} />

          {q.question_type === 'mcq' && (
            <div className="space-y-2">
              {q.options.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <button type="button" onClick={() => setField('correct_answer', String(i))}
                    className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                      q.correct_answer === String(i)
                        ? 'border-amber-500 bg-amber-500'
                        : 'border-gray-300 dark:border-gray-600 hover:border-amber-400'
                    }`}>
                    {q.correct_answer === String(i) && <CheckCircle2 size={12} strokeWidth={2.5} className="text-white" />}
                  </button>
                  <input value={opt} onChange={e => setOption(i, e.target.value)}
                    placeholder={`Option ${String.fromCharCode(65 + i)}`}
                    className={inputCls} />
                </div>
              ))}
              <p className="text-xs text-gray-400">Click the circle to mark the correct answer</p>
            </div>
          )}

          {q.question_type === 'descriptive' && (
            <p className="text-xs text-gray-400 italic">Students will type their answer. Mark manually after submission.</p>
          )}
        </div>
      </div>
    </div>
  )
}

export default function QuestionsEditor({ exam, onDone }) {
  const [questions, setQuestions] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const { data } = await supabase
        .from('questions')
        .select('*')
        .eq('exam_id', exam.id)
        .order('order_index')
      setQuestions(data?.map(q => ({
        ...q,
        options: q.options || ['', '', '', ''],
      })) || [])
      setLoading(false)
    }
    load()
  }, [exam.id])

  function addQuestion() {
    setQuestions(qs => [...qs, { ...EMPTY_Q, id: `new-${Date.now()}`, exam_id: exam.id, order_index: qs.length, _new: true }])
    setDirty(true)
  }

  function updateQuestion(index, updated) {
    setQuestions(qs => qs.map((q, i) => i === index ? updated : q))
    setDirty(true)
  }

  function removeQuestion(index) {
    setQuestions(qs => qs.filter((_, i) => i !== index))
    setDirty(true)
  }

  async function saveAll() {
    setError('')
    for (const q of questions) {
      if (!q.question_text.trim()) { setError('All questions must have text.'); return }
      if (q.question_type === 'mcq' && q.options.some(o => !o.trim())) {
        setError('All MCQ options must be filled in.'); return
      }
    }

    setSaving(true)
    try {
      // Delete removed questions (those in DB but not in current list)
      const { data: existing } = await supabase.from('questions').select('id').eq('exam_id', exam.id)
      const existingIds = existing?.map(q => q.id) || []
      const currentIds = questions.filter(q => !q._new).map(q => q.id)
      const toDelete = existingIds.filter(id => !currentIds.includes(id))
      if (toDelete.length) await supabase.from('questions').delete().in('id', toDelete)

      // Upsert all questions
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]
        const payload = {
          exam_id: exam.id,
          question_text: q.question_text,
          question_type: q.question_type,
          options: q.question_type === 'mcq' ? q.options : null,
          correct_answer: q.question_type === 'mcq' ? q.correct_answer : null,
          marks: q.marks,
          order_index: i,
        }
        if (q._new) {
          await supabase.from('questions').insert(payload)
        } else {
          await supabase.from('questions').update(payload).eq('id', q.id)
        }
      }

      // Recalculate total_marks
      const total = questions.reduce((sum, q) => sum + (q.marks || 0), 0)
      await supabase.from('exams').update({ total_marks: total }).eq('id', exam.id)

      setDirty(false)
      onDone()
    } catch (err) {
      setError(err.message || 'Failed to save questions.')
    } finally {
      setSaving(false)
    }
  }

  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0)

  if (loading) return (
    <div className="flex items-center justify-center py-12">
      <Loader2 size={24} strokeWidth={1.75} className="text-amber-500 animate-spin" />
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {questions.length} question{questions.length !== 1 ? 's' : ''} · {totalMarks} total marks
        </p>
        <button onClick={addQuestion}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-lg transition-colors">
          <Plus size={13} strokeWidth={1.75} /> Add Question
        </button>
      </div>

      {questions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl">
          <p className="text-sm text-gray-500 dark:text-gray-400">No questions yet</p>
          <p className="text-xs text-gray-400 mt-1">Click "Add Question" to start building your exam</p>
        </div>
      ) : (
        <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
          {questions.map((q, i) => (
            <QuestionCard key={q.id} q={q} index={i}
              onUpdate={updated => updateQuestion(i, updated)}
              onDelete={() => removeQuestion(i)} />
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 px-3 py-2.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-600 dark:text-red-400">
          <AlertCircle size={15} strokeWidth={1.75} className="shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      <button onClick={saveAll} disabled={saving || !dirty}
        className="w-full flex items-center justify-center gap-2 py-2.5 text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-xl transition-colors disabled:opacity-50">
        {saving && <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />}
        {saving ? 'Saving…' : dirty ? 'Save Questions' : 'All Changes Saved'}
      </button>
    </div>
  )
}
