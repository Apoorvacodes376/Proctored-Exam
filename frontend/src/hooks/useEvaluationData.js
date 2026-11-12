/**
 * useEvaluationData.js
 * Loads everything the Evaluation page needs for one or more of the
 * faculty member's exams. RLS limits every query to the caller's own
 * exams. Result shape matches evaluation/report.js buildReport().
 */

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const PAGE = 1000
const one = x => (Array.isArray(x) ? x[0] ?? null : x ?? null)

/** Fetch every row of a query, PAGE rows at a time (PostgREST caps responses). */
export async function fetchAll(makeQuery) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1)
    if (error) throw error
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE) return rows
  }
}

const inChunks = async (ids, fn, size = 100) => {
  const out = []
  for (let i = 0; i < ids.length; i += size) out.push(...await fn(ids.slice(i, i + size)))
  return out
}

export async function loadEvaluationData(client, exams) {
  const examIds = exams.map(e => e.id)
  const title = Object.fromEntries(exams.map(e => [e.id, e.title]))
  if (!examIds.length) {
    return { sessions: [], events: [], riskScores: [], riskEval: [], trials: [], intervals: [], identity: [], performance: [], modelCards: [] }
  }

  const [sessions, rawEvents, riskScores, trials, identity, performance, modelCards] = await Promise.all([
    fetchAll(() => client.from('exam_sessions')
      .select('id, exam_id, status, started_at, submitted_at, student:students ( name, student_id )')
      .in('exam_id', examIds).order('started_at')),
    fetchAll(() => client.from('proctoring_events')
      .select(`id, exam_id, event_type, severity, confidence, occurred_at, ended_at, created_at, metadata, snapshot_id,
               ps:proctoring_sessions ( exam_session_id ), review:faculty_reviews ( decision ),
               snapshot:proctoring_snapshots ( storage_path )`)
      .in('exam_id', examIds).order('occurred_at')),
    fetchAll(() => client.from('risk_scores')
      .select('exam_session_id, exam_id, score, review_threshold:breakdown->review_threshold')
      .in('exam_id', examIds)),
    fetchAll(() => client.from('evaluation_trials').select('*').in('exam_id', examIds)),
    fetchAll(() => client.from('identity_verifications')
      .select('id, exam_id, student_id, result, distance, threshold, attempted_at, student:students ( name, student_id ), ground_truth:identity_ground_truth ( is_genuine, data_kind, notes )')
      .in('exam_id', examIds).order('attempted_at')),
    fetchAll(() => client.from('monitoring_performance').select('*').in('exam_id', examIds)),
    fetchAll(() => client.from('model_evaluations').select('*').order('imported_at', { ascending: false })),
  ])

  const intervals = await inChunks(trials.map(t => t.id), ids =>
    fetchAll(() => client.from('ground_truth_intervals').select('*').in('trial_id', ids).order('starts_at')))

  const riskEval = []
  for (const id of examIds) {
    const { data, error } = await client.rpc('risk_evaluation_data', { p_exam_id: id })
    if (error) throw error
    riskEval.push(...(data ?? []).map(r => ({ ...r, exam_id: id })))
  }

  const sessionById = new Map(sessions.map(s => [s.id, s]))
  const kindBySession = new Map(trials.map(t => [t.exam_session_id, t.data_kind]))
  const events = rawEvents.map(e => {
    const exam_session_id = one(e.ps)?.exam_session_id ?? null
    return {
      ...e, ps: undefined, exam_session_id,
      review: one(e.review), snapshot: one(e.snapshot),
      student: sessionById.get(exam_session_id)?.student ?? null,
      exam_title: title[e.exam_id], data_kind: kindBySession.get(exam_session_id) ?? null,
    }
  })

  return {
    sessions: sessions.map(s => ({ ...s, student: one(s.student), exam_title: title[s.exam_id] })),
    events,
    riskScores,
    riskEval: riskEval.map(r => ({ ...r, student: sessionById.get(r.exam_session_id)?.student ?? null,
      exam_title: title[r.exam_id], data_kind: kindBySession.get(r.exam_session_id) ?? null })),
    trials,
    intervals,
    identity: identity.map(a => ({ ...a, student: one(a.student), ground_truth: one(a.ground_truth) })),
    performance,
    modelCards: modelCards.filter(c => c.exam_id == null || examIds.includes(c.exam_id)),
  }
}

export function useEvaluationData(exams) {
  const [state, setState] = useState({ data: null, loading: false, error: '' })
  const key = exams.map(e => e.id).join(',')

  const reload = useCallback(async () => {
    if (!exams.length) { setState({ data: null, loading: false, error: '' }); return }
    setState(s => ({ ...s, loading: true, error: '' }))
    try {
      setState({ data: await loadEvaluationData(supabase, exams), loading: false, error: '' })
    } catch (err) {
      setState({ data: null, loading: false, error: err.message || String(err) })
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { reload() }, [reload])
  return { ...state, reload }
}
