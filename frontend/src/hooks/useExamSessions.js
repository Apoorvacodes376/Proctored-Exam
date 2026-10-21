/**
 * useExamSessions.js
 * Loads the exam sessions of one exam (or one session) for the faculty
 * monitor/review pages and keeps them current over Supabase Realtime.
 *
 * Returns raw SESSION_SELECT rows keyed by id; pages turn them into view
 * rows with src/review/liveSessions.js.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { SESSION_SELECT } from '../review/liveSessions'
import { subscribeToExam, createSessionReloader } from '../review/realtime'

/**
 * @param {object} opts
 * @param {string|null} opts.examId
 * @param {string|null} [opts.sessionId]  restrict to one session (review page)
 */
export function useExamSessions({ examId, sessionId = null }) {
  const [rows, setRows]       = useState({})          // id → raw row
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [live, setLive]       = useState('connecting') // 'connecting' | 'live' | 'reconnecting' | 'error'
  const [updatedAt, setUpdatedAt] = useState(null)
  const examRef = useRef(examId)
  useEffect(() => { examRef.current = examId }, [examId])

  const loadAll = useCallback(async () => {
    if (!examId) return
    // Close sessions whose time ran out but whose browser never submitted
    // (Phase 6). Runs on every load/poll while a faculty page is open; a
    // scheduled job can do the same server-side (see README).
    const fin = await supabase.rpc('finalize_expired_sessions', { p_exam_id: examId })
    if (fin.error) console.warn('[useExamSessions] could not finalize expired sessions:', fin.error.message)
    let q = supabase.from('exam_sessions').select(SESSION_SELECT).eq('exam_id', examId)
    if (sessionId) q = q.eq('id', sessionId)
    const { data, error: err } = await q.order('started_at', { ascending: true })
    if (examRef.current !== examId) return
    if (err) { setError(err.message); setLoading(false); return }
    setRows(Object.fromEntries((data ?? []).map(r => [r.id, r])))
    setError('')
    setLoading(false)
    setUpdatedAt(Date.now())
  }, [examId, sessionId])

  const loadOne = useCallback(async id => {
    if (sessionId && id !== sessionId) return
    const { data, error: err } = await supabase.from('exam_sessions').select(SESSION_SELECT).eq('id', id).maybeSingle()
    if (err) { console.warn('[useExamSessions] reload failed:', err.message); return }
    setRows(prev => {
      const next = { ...prev }
      if (data && data.exam_id === examRef.current) next[id] = data
      else delete next[id]
      return next
    })
    setUpdatedAt(Date.now())
  }, [sessionId])

  useEffect(() => {
    if (!examId) { setRows({}); setLoading(false); return }
    setLoading(true)
    setRows({})
    loadAll()

    const reloader = createSessionReloader(loadOne)
    const unsubscribe = subscribeToExam(supabase, examId, {
      onSessionChanged: id => reloader.schedule(id),
      onStatus: setLive,
      onResync: loadAll,
    })
    // Safety net in case a change notification is ever missed.
    const poll = setInterval(loadAll, 60_000)

    return () => {
      unsubscribe()
      reloader.cancelAll()
      clearInterval(poll)
    }
  }, [examId, loadAll, loadOne])

  return { rows, loading, error, live, updatedAt, reload: loadAll }
}

/** Faculty member's exams, newest first. */
export function useFacultyExams(profileId) {
  const [exams, setExams] = useState([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    if (!profileId) return
    supabase.from('exams')
      .select('id, title, subject, exam_date, start_time, duration_mins')
      .eq('faculty_id', profileId)
      .order('exam_date', { ascending: false })
      .then(({ data }) => { setExams(data ?? []); setLoading(false) })
  }, [profileId])
  return { exams, loading }
}

/** Re-render every `ms` so "online"/"last seen" stay accurate between changes. */
export function useNow(ms = 5_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}
