/**
 * liveSessions.js
 * Turns the faculty monitor query rows (exam session + student +
 * proctoring live status + stored risk breakdown + review decision) into
 * flat rows for the live dashboard. Pure — no React, no Supabase.
 */

/** A student is shown as connected if a heartbeat arrived within this window. */
export const ONLINE_WINDOW_MS = 30_000

/** PostgREST select used by the monitor and review list. */
export const SESSION_SELECT = `
  id, exam_id, status, started_at, submitted_at,
  student:students ( id, name, student_id ),
  proctoring:proctoring_sessions ( id, live_status, last_heartbeat_at, stream_status ),
  risk:risk_scores ( score, risk_level, needs_review, identity_flag, review_reasons, open_episodes, total_events, breakdown, computed_at ),
  review:session_reviews ( status, outcome, decided_at )
`

const one = x => (Array.isArray(x) ? x[0] ?? null : x ?? null)

const EPISODE_STATE = {
  face_not_detected:  'faceMissing',
  multiple_faces:     'multiplePeople',
  tab_switch:         'away',
  focus_lost:         'away',
  speech_detected:    'speech',
  camera_interrupted: 'cameraDown',
  mic_interrupted:    'micDown',
}

/** Raw-event counts by dashboard column, from the stored breakdown. */
export function alertCounts(breakdown) {
  const c = breakdown?.type_counts ?? {}
  const n = k => c[k] ?? 0
  return {
    missingFace:      n('face_not_detected'),
    multiplePeople:   n('multiple_faces'),
    objects:          n('phone_detected') + n('object_detected'),
    audio:            n('speech_detected') + n('unusual_noise') + n('audio_detected'),
    tabSwitches:      n('tab_switch') + n('focus_lost'),
    media:            n('camera_interrupted') + n('mic_interrupted'),
    total:            breakdown?.total_events ?? 0,
  }
}

/** Which conditions are ongoing right now (open, non-dismissed episodes). */
export function openConditions(breakdown) {
  const open = {}
  for (const e of breakdown?.events ?? []) {
    const key = EPISODE_STATE[e.type]
    if (key && !e.ended_at && e.status !== 'dismissed') open[key] = true
  }
  return open
}

/**
 * @param {object} row   one row from SESSION_SELECT
 * @param {number} now   ms timestamp
 */
export function toMonitorRow(row, now = Date.now()) {
  const student    = one(row.student) ?? {}
  const proctoring = one(row.proctoring) ?? {}
  const risk       = one(row.risk) ?? {}
  const review     = one(row.review)
  const live       = proctoring.live_status ?? {}
  const beatAt     = proctoring.last_heartbeat_at ? Date.parse(proctoring.last_heartbeat_at) : null
  const inProgress = row.status === 'in_progress'
  const online     = inProgress && beatAt !== null && now - beatAt <= ONLINE_WINDOW_MS
  const open       = openConditions(risk.breakdown)

  return {
    id:           row.id,
    name:         student.name ?? 'Unknown student',
    studentNo:    student.student_id ?? '',
    examStatus:   row.status,
    startedAt:    row.started_at,
    online,
    lastSeenMs:   beatAt === null ? null : Math.max(0, now - beatAt),
    // Live status as reported by the student's browser (self-reported).
    camera:       online ? (live.camera ?? 'unknown')     : 'unknown',
    microphone:   online ? (live.microphone ?? 'unknown') : 'unknown',
    face:         open.faceMissing ? 'absent' : online ? (live.face ?? 'unknown') : 'unknown',
    away:         !!open.away || (online && !!live.away),
    multiplePeopleNow: !!open.multiplePeople,
    speakingNow:  !!open.speech,
    counts:       alertCounts(risk.breakdown),
    score:        risk.score === null || risk.score === undefined ? null : Number(risk.score),
    level:        risk.risk_level ?? 'low',
    needsReview:  !!risk.needs_review,
    identityFlag: !!risk.identity_flag,
    reasons:      risk.review_reasons ?? [],
    reviewStatus: review?.status ?? 'not_reviewed',
    outcome:      review?.outcome ?? null,
  }
}

/** Which exam session a Realtime change refers to. */
export function sessionIdFromChange(table, payload) {
  const rec = payload?.new && Object.keys(payload.new).length ? payload.new : payload?.old ?? {}
  return table === 'exam_sessions' ? rec.id ?? null : rec.exam_session_id ?? null
}

/** Default ordering: needs review first, then highest score, then name. */
export function sortRows(rows) {
  return [...rows].sort((a, b) =>
    (b.needsReview - a.needsReview) ||
    ((b.score ?? -1) - (a.score ?? -1)) ||
    a.name.localeCompare(b.name))
}
