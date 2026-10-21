/**
 * csv.js
 * RFC 4180 CSV for faculty exports, with spreadsheet formula-injection
 * protection: text cells that start with = + - @ (or a tab / carriage
 * return) are prefixed with an apostrophe so Excel/Sheets show them as
 * text instead of executing them. Student names and free-text notes are
 * user-controlled, so this matters.
 */

import { CATEGORY_OF_EVENT } from './groundTruth'

const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  let s = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (FORMULA_START.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** columns: [{ key, header }] or keys. Rows are objects. */
export function toCsv(rows, columns) {
  const cols = columns.map(c => (typeof c === 'string' ? { key: c, header: c } : c))
  const lines = [cols.map(c => csvCell(c.header)).join(',')]
  for (const row of rows) lines.push(cols.map(c => csvCell(typeof c.value === 'function' ? c.value(row) : row[c.key])).join(','))
  return lines.join('\r\n') + '\r\n'
}

/** Trigger a download in the browser (UTF-8 with BOM so Excel detects the encoding). */
export function downloadCsv(filename, csv) {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

const durationS = e => (e.ended_at ? Math.max(0, (new Date(e.ended_at) - new Date(e.occurred_at)) / 1000) : null)

/** Columns of the event-log export. Evidence is exported as the private storage path, never a signed URL. */
export const EVENT_LOG_COLUMNS = [
  { key: 'exam',            header: 'exam',             value: e => e.exam_title },
  { key: 'student_name',    header: 'student_name',     value: e => e.student?.name },
  { key: 'student_id',      header: 'student_id',       value: e => e.student?.student_id },
  { key: 'exam_session_id', header: 'exam_session_id' },
  { key: 'event_id',        header: 'event_id',         value: e => e.id },
  { key: 'event_type',      header: 'event_type' },
  { key: 'category',        header: 'category',         value: e => CATEGORY_OF_EVENT[e.event_type] ?? '' },
  { key: 'severity',        header: 'severity' },
  { key: 'confidence',      header: 'confidence',       value: e => (e.confidence == null ? null : Number(e.confidence)) },
  { key: 'occurred_at',     header: 'occurred_at' },
  { key: 'ended_at',        header: 'ended_at' },
  { key: 'duration_s',      header: 'duration_s',       value: durationS },
  { key: 'logged_at',       header: 'logged_at_server', value: e => e.created_at },
  { key: 'review',          header: 'review_decision',  value: e => e.review?.decision ?? '' },
  { key: 'evidence',        header: 'evidence_path',    value: e => e.snapshot?.storage_path ?? '' },
  { key: 'data_kind',       header: 'data_kind',        value: e => e.data_kind ?? 'live (no ground truth)' },
  { key: 'details',         header: 'details',          value: e => e.metadata },
]

export const RESULT_COLUMNS = ['section', 'metric', 'subset', 'provenance', 'value', 'ci_low', 'ci_high', 'n', 'notes']

export const RISK_COLUMNS = [
  { key: 'exam',  header: 'exam', value: r => r.exam_title },
  { key: 'student_name', header: 'student_name', value: r => r.student?.name },
  { key: 'student_id',   header: 'student_id',   value: r => r.student?.student_id },
  { key: 'exam_session_id', header: 'exam_session_id' },
  { key: 'status', header: 'session_status' },
  { key: 'live_score', header: 'live_score', value: r => (r.live_score == null ? null : Number(r.live_score)) },
  { key: 'score_without_reviews', header: 'score_without_reviews', value: r => (r.score_without_reviews == null ? null : Number(r.score_without_reviews)) },
  { key: 'review_threshold', header: 'review_threshold', value: r => Number(r.review_threshold) },
  { key: 'outcome', header: 'faculty_outcome' },
  { key: 'data_kind', header: 'data_kind', value: r => r.data_kind ?? 'live (no ground truth)' },
]
