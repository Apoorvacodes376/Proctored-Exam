/**
 * eventLogger.js
 * Module 7 & 8: Event Logging + Evidence
 *
 * createEventLogger() writes proctoring events and evidence snapshots to
 * Supabase for one exam session. Every event records:
 *   student_id, exam_id      (also stamped server-side from the session —
 *                             see phase4_patch_monitoring.sql)
 *   event_type, severity, confidence (when the detector provides one),
 *   occurred_at, metadata, snapshot_id (when evidence was captured)
 *
 * Design:
 *   - IDs are generated client-side, so inserts need no read-back (students
 *     have no SELECT permission on events or evidence).
 *   - A per-key cooldown is checked BEFORE capturing evidence, so a flapping
 *     detector cannot upload a stream of snapshots.
 *   - An episode (face absent, camera lost, away from tab…) is logged once
 *     when it starts; close(eventId) records when it ended via the
 *     close_proctoring_event RPC instead of logging a second event.
 *   - Failed writes are queued and retried (flush()), so a short network
 *     drop does not lose events.
 *   - Evidence path: proctoring-frames/<exam_session_id>/<event_id>.jpg
 *     (private bucket; only the exam's faculty can read it).
 *
 * The Supabase client and frame capture are injected — no React, and
 * testable without a browser.
 */

export const SEVERITY = {
  face_not_detected:  'high',
  multiple_faces:     'critical',
  phone_detected:     'critical',
  object_detected:    'high',
  speech_detected:    'medium',
  unusual_noise:      'low',
  camera_interrupted: 'high',
  mic_interrupted:    'medium',
  tab_switch:         'high',
  focus_lost:         'medium',
}

/** Minimum gap between two events with the same dedupe key. */
export const DEFAULT_COOLDOWN_MS = {
  face_not_detected:  15_000,
  multiple_faces:     30_000,
  phone_detected:     30_000,
  object_detected:    30_000,
  speech_detected:    30_000,
  unusual_noise:      30_000,
  camera_interrupted:      0,   // already one-per-interruption upstream
  mic_interrupted:         0,
  tab_switch:              0,   // every departure counts
  focus_lost:              0,
}

const MAX_QUEUE = 200

/**
 * @param {object}   deps
 * @param {object}   deps.client          Supabase client
 * @param {string}   deps.examSessionId
 * @param {string}   deps.studentId
 * @param {string}   deps.examId
 * @param {function} [deps.captureFrame]  async () => Blob|null
 * @param {function} [deps.uuid]
 * @param {function} [deps.now]           () => ms
 * @param {object}   [deps.cooldownMs]
 */
export function createEventLogger({
  client,
  examSessionId,
  studentId,
  examId,
  captureFrame = null,
  uuid = () => globalThis.crypto.randomUUID(),
  now  = () => Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
}) {
  let proctoringSessionId = null
  const lastFired = new Map()
  const queue     = []              // [{ kind: 'event'|'close', ... }]
  const unsent    = new Set()       // event ids still waiting in the queue

  function enqueue(item) {
    if (queue.length >= MAX_QUEUE) queue.shift()
    queue.push(item)
  }

  /** Get or create the proctoring_sessions row. Safe to call repeatedly. */
  async function start({ webcamEnabled = true } = {}) {
    if (proctoringSessionId) return proctoringSessionId

    const { data: existing, error: selErr } = await client
      .from('proctoring_sessions').select('id').eq('exam_session_id', examSessionId).maybeSingle()
    if (selErr) throw selErr
    if (existing) {
      proctoringSessionId = existing.id
      await client.from('proctoring_sessions')
        .update({ stream_status: 'active', webcam_enabled: webcamEnabled, ended_at: null })
        .eq('id', existing.id)
      return proctoringSessionId
    }

    const id = uuid()
    const { error } = await client.from('proctoring_sessions').insert({
      id, exam_session_id: examSessionId, stream_status: 'active', webcam_enabled: webcamEnabled,
    })
    if (error) {
      // Lost a race with another tab/reload — read the winner.
      const { data } = await client.from('proctoring_sessions').select('id').eq('exam_session_id', examSessionId).maybeSingle()
      if (!data) throw error
      proctoringSessionId = data.id
    } else {
      proctoringSessionId = id
    }
    return proctoringSessionId
  }

  async function uploadEvidence(eventId, occurredAt) {
    if (!captureFrame) return { snapshotId: null }
    let blob
    try { blob = await captureFrame() } catch (err) { return { snapshotId: null, error: `capture: ${err.message}` } }
    if (!blob) return { snapshotId: null, error: 'camera frame unavailable' }

    const path = `${examSessionId}/${eventId}.jpg`
    const { error: upErr } = await client.storage
      .from('proctoring-frames')
      .upload(path, blob, { contentType: 'image/jpeg', upsert: false })
    if (upErr) return { snapshotId: null, error: `upload: ${upErr.message}` }

    const snapshotId = uuid()
    const { error: rowErr } = await client.from('proctoring_snapshots').insert({
      id: snapshotId,
      proctoring_session_id: proctoringSessionId,
      storage_path: path,
      frame_type: 'webcam',
      captured_at: occurredAt,
    })
    if (rowErr) return { snapshotId: null, error: `snapshot row: ${rowErr.message}`, path }
    return { snapshotId, path }
  }

  async function insertEvent(row) {
    const { error } = await client.from('proctoring_events').insert(row)
    if (error) {
      unsent.add(row.id)
      enqueue({ kind: 'event', row })
      return false
    }
    return true
  }

  /**
   * Log one event. Returns the record (with its id) or null when
   * suppressed by the cooldown.
   *
   * @param {object}  e
   * @param {string}  e.eventType
   * @param {string}  [e.severity]     defaults to SEVERITY[eventType]
   * @param {number}  [e.confidence]   0–1, omitted when the detector has none
   * @param {object}  [e.metadata]
   * @param {boolean} [e.evidence]     capture a webcam snapshot
   * @param {string}  [e.dedupeKey]    cooldown key (default: eventType)
   * @param {number}  [e.occurredAt]   ms timestamp (default: now)
   */
  async function log({ eventType, severity, confidence = null, metadata = null, evidence = false, dedupeKey, occurredAt }) {
    if (!proctoringSessionId) throw new Error('eventLogger.start() has not completed')

    const key = dedupeKey ?? eventType
    const t   = now()
    const gap = cooldownMs[eventType] ?? 10_000
    if (gap > 0 && lastFired.has(key) && t - lastFired.get(key) < gap) return null
    lastFired.set(key, t)

    const id = uuid()
    const occurred = new Date(occurredAt ?? t).toISOString()
    const row = {
      id,
      proctoring_session_id: proctoringSessionId,
      student_id:  studentId,
      exam_id:     examId,
      event_type:  eventType,
      severity:    severity ?? SEVERITY[eventType] ?? 'medium',
      occurred_at: occurred,
    }
    if (confidence !== null && confidence !== undefined && Number.isFinite(confidence)) {
      row.confidence = Math.round(Math.min(1, Math.max(0, confidence)) * 10_000) / 10_000
    }
    const meta = { ...(metadata ?? {}) }

    if (evidence) {
      const ev = await uploadEvidence(id, occurred)
      if (ev.snapshotId) row.snapshot_id = ev.snapshotId
      if (ev.error) meta.evidence_error = ev.error
    }
    if (Object.keys(meta).length) row.metadata = meta

    const sent = await insertEvent(row)
    return { ...row, sent }
  }

  /** Record the end of an episode started by log(). */
  async function close(eventId, endedAt = now()) {
    if (!eventId) return
    const item = { kind: 'close', eventId, endedAt: new Date(endedAt).toISOString() }
    if (unsent.has(eventId)) { enqueue(item); return }       // must follow its insert
    const { error } = await client.rpc('close_proctoring_event', { p_event_id: eventId, p_ended_at: item.endedAt })
    if (error) enqueue(item)
  }

  /** Retry queued writes, in order. Stops at the first failure. */
  async function flush() {
    while (queue.length) {
      const item = queue[0]
      let error
      if (item.kind === 'event') {
        ;({ error } = await client.from('proctoring_events').insert(item.row))
        // A duplicate id means an earlier attempt actually landed.
        if (error?.code === '23505') error = null
        if (!error) unsent.delete(item.row.id)
      } else {
        ;({ error } = await client.rpc('close_proctoring_event', { p_event_id: item.eventId, p_ended_at: item.endedAt }))
      }
      if (error) return false
      queue.shift()
    }
    return true
  }

  async function end() {
    await flush().catch(() => {})
    if (!proctoringSessionId) return
    await client.from('proctoring_sessions')
      .update({ stream_status: 'ended', ended_at: new Date(now()).toISOString() })
      .eq('id', proctoringSessionId)
  }

  return {
    start, log, close, flush, end,
    get proctoringSessionId() { return proctoringSessionId },
    get pending() { return queue.length },
  }
}

/**
 * Browser helper: grab the current webcam frame as a JPEG blob
 * (downscaled to at most maxWidth to keep evidence small).
 */
export function captureVideoFrame(videoEl, { maxWidth = 640, quality = 0.75 } = {}) {
  if (!videoEl || videoEl.readyState < 2 || !videoEl.videoWidth) return Promise.resolve(null)
  const scale  = Math.min(1, maxWidth / videoEl.videoWidth)
  const canvas = document.createElement('canvas')
  canvas.width  = Math.round(videoEl.videoWidth * scale)
  canvas.height = Math.round(videoEl.videoHeight * scale)
  canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height)
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
}
