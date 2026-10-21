/**
 * eventLogger.js
 * Supabase write layer for Phase 4 proctoring.
 *
 * Responsibilities:
 *  - Create / retrieve the proctoring_session row for an exam_session.
 *  - Insert proctoring_events with deduplication (no repeated identical
 *    events within a configurable cooldown window).
 *  - Upload webcam snapshots to the proctoring-frames bucket and insert
 *    proctoring_snapshots rows.
 *
 * All functions are pure async — no React state, fully testable in isolation.
 */

import { supabase } from '../lib/supabase'

// Minimum ms between identical event_type inserts (per type).
const COOLDOWN_MS = {
  face_not_detected: 15_000,
  multiple_faces:    10_000,
  tab_switch:         5_000,
  audio_detected:    20_000,
  phone_detected:    10_000,
  object_detected:   10_000,
  fullscreen_exit:    5_000,
  idle_timeout:      30_000,
}
const DEFAULT_COOLDOWN = 10_000

// In-memory last-fired timestamps per event type.
const lastFired = {}

function isCooledDown(eventType) {
  const cooldown = COOLDOWN_MS[eventType] ?? DEFAULT_COOLDOWN
  const last = lastFired[eventType] ?? 0
  return Date.now() - last >= cooldown
}

function markFired(eventType) {
  lastFired[eventType] = Date.now()
}

// ── Session management ────────────────────────────────────────

/**
 * Upsert a proctoring_session for the given exam_session_id.
 * Returns the proctoring_session row.
 */
export async function ensureProctoringSession(examSessionId, { webcamEnabled = true, screenEnabled = false } = {}) {
  // Try to fetch existing first (idempotent on re-entry after resume).
  const { data: existing } = await supabase
    .from('proctoring_sessions')
    .select('*')
    .eq('exam_session_id', examSessionId)
    .maybeSingle()

  if (existing) return existing

  const { data, error } = await supabase
    .from('proctoring_sessions')
    .insert({
      exam_session_id: examSessionId,
      stream_status:   'active',
      webcam_enabled:  webcamEnabled,
      screen_enabled:  screenEnabled,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * Mark a proctoring_session as ended.
 */
export async function endProctoringSession(proctoringSessionId) {
  await supabase
    .from('proctoring_sessions')
    .update({ stream_status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', proctoringSessionId)
}

// ── Event logging ─────────────────────────────────────────────

/**
 * Log a proctoring event.
 * Silently skips if the same event_type was logged within its cooldown.
 *
 * @param {string} proctoringSessionId
 * @param {object} opts
 * @param {string} opts.eventType   — one of the CHECK-constrained values
 * @param {string} opts.severity    — 'low' | 'medium' | 'high' | 'critical'
 * @param {number} [opts.confidence] — 0–1
 * @param {string} [opts.snapshotId] — proctoring_snapshots.id
 * @param {object} [opts.metadata]  — arbitrary JSON
 * @param {boolean} [opts.force]    — bypass cooldown (e.g. first occurrence)
 * @returns {object|null} inserted row or null if skipped
 */
export async function logEvent(proctoringSessionId, {
  eventType,
  severity = 'medium',
  confidence = null,
  snapshotId = null,
  metadata = null,
  force = false,
}) {
  if (!force && !isCooledDown(eventType)) return null

  markFired(eventType)

  const payload = {
    proctoring_session_id: proctoringSessionId,
    event_type:            eventType,
    severity,
    occurred_at:           new Date().toISOString(),
  }
  if (confidence !== null) payload.confidence = confidence
  if (snapshotId)          payload.snapshot_id = snapshotId
  if (metadata)            payload.metadata = metadata

  const { data, error } = await supabase
    .from('proctoring_events')
    .insert(payload)
    .select()
    .single()

  if (error) {
    console.warn('[eventLogger] insert failed:', error.message)
    return null
  }
  return data
}

// ── Snapshot upload ───────────────────────────────────────────

/**
 * Capture a JPEG blob from a <video> element and upload it to
 * the proctoring-frames bucket.
 *
 * Path: <examSessionId>/<timestamp>_webcam.jpg
 *
 * @param {HTMLVideoElement} videoEl
 * @param {string} proctoringSessionId
 * @param {string} examSessionId  — used as the storage folder
 * @returns {string|null} proctoring_snapshots.id or null on failure
 */
export async function captureAndUploadSnapshot(videoEl, proctoringSessionId, examSessionId) {
  try {
    if (!videoEl || videoEl.readyState < 2) return null

    const canvas = document.createElement('canvas')
    canvas.width  = videoEl.videoWidth  || 320
    canvas.height = videoEl.videoHeight || 240
    canvas.getContext('2d').drawImage(videoEl, 0, 0)

    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.7))
    if (!blob) return null

    const ts   = Date.now()
    const path = `${examSessionId}/${ts}_webcam.jpg`

    const { error: uploadErr } = await supabase.storage
      .from('proctoring-frames')
      .upload(path, blob, { contentType: 'image/jpeg', upsert: false })

    if (uploadErr) {
      console.warn('[eventLogger] snapshot upload failed:', uploadErr.message)
      return null
    }

    const { data, error: dbErr } = await supabase
      .from('proctoring_snapshots')
      .insert({
        proctoring_session_id: proctoringSessionId,
        storage_path:          path,
        frame_type:            'webcam',
        captured_at:           new Date(ts).toISOString(),
      })
      .select('id')
      .single()

    if (dbErr) {
      console.warn('[eventLogger] snapshot row failed:', dbErr.message)
      return null
    }
    return data.id
  } catch (err) {
    console.warn('[eventLogger] captureAndUploadSnapshot error:', err.message)
    return null
  }
}

/** Reset cooldown state — call when a new exam session starts. */
export function resetCooldowns() {
  Object.keys(lastFired).forEach(k => delete lastFired[k])
}
