/**
 * riskView.js
 * Presentation helpers for a stored risk breakdown (see
 * compute_risk_breakdown in phase5_patch_monitoring_review.sql).
 * Pure — no React, no Supabase.
 */

export const EVENT_LABELS = {
  face_not_detected:  'Face not visible',
  multiple_faces:     'Multiple people',
  phone_detected:     'Phone detected',
  object_detected:    'Object detected',
  speech_detected:    'Speech',
  unusual_noise:      'Loud noise',
  audio_detected:     'Audio',
  tab_switch:         'Left exam tab',
  focus_lost:         'Window lost focus',
  fullscreen_exit:    'Left full screen',
  camera_interrupted: 'Camera interrupted',
  mic_interrupted:    'Microphone interrupted',
  gaze_away:          'Looking away',
  copy_paste:         'Copy / paste',
  idle_timeout:       'Idle',
}

export const STATUS_LABELS = {
  counted:          'Counted',
  duplicate:        'Merged duplicate',
  dismissed:        'Dismissed by reviewer',
  below_confidence: 'Below confidence threshold',
  not_scored:       'Not scored',
}

export const DECISION_LABELS = {
  pending:   'Not reviewed',
  dismissed: 'Dismissed — not a concern',
  confirmed: 'Confirmed — behaviour occurred',
  escalated: 'Escalated',
}

export const SESSION_STATUS_LABELS = {
  not_reviewed:   'Not reviewed',
  in_review:      'In review',
  cleared:        'Cleared for evaluation',
  further_review: 'Hold — further review before evaluation',
}

export const OUTCOME_LABELS = {
  no_misconduct: 'No misconduct found',
  inconclusive:  'Inconclusive',
  misconduct:    'Misconduct found',
}

export const IDENTITY_REASON_LABELS = {
  manual_review_requested: 'Student requested manual identity review',
  repeated_failures:       'Repeated failed or inconclusive face matches',
  never_passed:            'No successful face match recorded',
  no_reference:            'Reference photo missing or has no detectable face',
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—'
  const s = Math.round(seconds)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
}

export function formatConfidence(c) {
  return c === null || c === undefined ? '—' : `${Math.round(Number(c) * 100)}%`
}

/** Category rows sorted by contribution, with a plain-language formula. */
export function categoryRows(breakdown) {
  return Object.entries(breakdown?.categories ?? {})
    .map(([key, c]) => ({
      key,
      label:        c.label ?? key,
      weight:       c.weight,
      events:       c.events,
      counted:      c.counted,
      duplicates:   c.duplicates,
      dismissed:    c.dismissed,
      belowConfidence: c.below_confidence,
      durationS:    c.duration_s,
      effective:    c.effective,
      saturation:   c.saturation,
      normalised:   c.normalised,
      contribution: c.contribution,
      explanation:  `${c.effective} effective of ${c.saturation} to saturate → ${Math.round(c.normalised * 100)}% × weight ${c.weight}`,
    }))
    .sort((a, b) => b.contribution - a.contribution || a.label.localeCompare(b.label))
}

/** All events oldest-first, with display fields. */
export function eventTimeline(breakdown) {
  return [...(breakdown?.events ?? [])]
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || String(a.id).localeCompare(String(b.id)))
    .map(e => ({
      ...e,
      label:       EVENT_LABELS[e.type] ?? e.type,
      statusLabel: STATUS_LABELS[e.status] ?? e.status,
      open:        !e.ended_at && e.duration_s !== null && e.duration_s !== undefined,
      scored:      e.status === 'counted' || e.status === 'duplicate',
    }))
}

/** Identity summary kept apart from the behavioural score. */
export function identitySummary(identity) {
  if (!identity || !identity.attempts) {
    return { flag: false, headline: 'No verification attempts recorded', reasons: [] }
  }
  const parts = [`${identity.attempts} attempt${identity.attempts === 1 ? '' : 's'}`]
  if (identity.passed)       parts.push(`${identity.passed} passed`)
  if (identity.failed)       parts.push(`${identity.failed} failed`)
  if (identity.inconclusive) parts.push(`${identity.inconclusive} inconclusive`)
  return {
    flag:     !!identity.flag,
    headline: parts.join(' · '),
    reasons:  (identity.reasons ?? []).map(r => IDENTITY_REASON_LABELS[r] ?? r),
    bestDistance: identity.best_distance,
  }
}

/** Why a session is on the review list, in words. */
export function reviewReasonText(reasons = [], breakdown) {
  return reasons.map(r =>
    r === 'risk_score' ? `Behavioural risk score ${breakdown?.score ?? '?'} ≥ review threshold ${breakdown?.review_threshold ?? '?'}`
    : r === 'identity' ? 'Identity verification needs attention'
    : r)
}
