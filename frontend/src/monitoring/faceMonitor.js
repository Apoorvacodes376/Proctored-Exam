/**
 * faceMonitor.js
 * Module 1 & 2: Face Presence + Multiple-Person Detection
 *
 * createFaceAnalyzer() is the pure decision logic: feed it the face
 * detections from each scan and it returns edge-triggered events.
 * startFaceMonitor() is the browser adapter that runs @vladmandic/face-api
 * (SSD MobileNet v1) on a <video> element at a fixed interval.
 *
 * Events (one start/end pair per continuous episode — never repeated
 * while the condition simply persists):
 *   face_absent      no face for longer than gracePeriodMs
 *   face_present     face is back after a reported absence
 *   multiple_faces   >1 face in at least multiFaceMinHits of the last
 *                    multiFaceWindow scans (filters one-frame glitches)
 *   single_face      the multiple-face episode has cleared
 *
 * Limitations: a face turned well away from the camera, heavy backlight
 * or a covered lens all read as "no face". People outside the camera's
 * field of view cannot be detected. Photos/posters of faces may count.
 *
 * No React, no Supabase.
 */

export const FACE_DEFAULTS = {
  scanIntervalMs:   2_000,
  gracePeriodMs:    8_000,   // configurable grace period before "face absent"
  minConfidence:      0.5,
  multiFaceWindow:      3,
  multiFaceMinHits:     2,
}

/**
 * @param {object} [options] overrides for FACE_DEFAULTS
 * @returns {{ update(detections: {score:number}[], now: number): object[], reset(): void }}
 */
export function createFaceAnalyzer(options = {}) {
  const cfg = { ...FACE_DEFAULTS, ...options }

  let absentSince  = null
  let absentAlerted = false
  let history      = []        // recent face counts
  let multiActive  = false

  function update(detections, now = Date.now()) {
    const faces  = detections.filter(d => (d.score ?? 1) >= cfg.minConfidence)
    const count  = faces.length
    const events = []

    // ── Presence ──
    if (count === 0) {
      if (absentSince === null) absentSince = now
      if (!absentAlerted && now - absentSince >= cfg.gracePeriodMs) {
        absentAlerted = true
        events.push({ type: 'face_absent', since: absentSince, durationMs: now - absentSince })
      }
    } else {
      if (absentAlerted) {
        events.push({ type: 'face_present', absentMs: now - absentSince })
      }
      absentSince   = null
      absentAlerted = false
    }

    // ── Multiple people ──
    history.push(count)
    if (history.length > cfg.multiFaceWindow) history.shift()
    const hits = history.filter(c => c > 1).length

    if (!multiActive && count > 1 && hits >= cfg.multiFaceMinHits) {
      multiActive = true
      // Confidence that ≥2 people are present is bounded by the
      // second-most-confident face.
      const scores = faces.map(f => f.score ?? 1).sort((a, b) => b - a)
      events.push({ type: 'multiple_faces', count, confidence: scores[1] })
    } else if (multiActive && hits === 0) {
      multiActive = false
      events.push({ type: 'single_face' })
    }

    return events
  }

  function reset() {
    absentSince = null; absentAlerted = false; history = []; multiActive = false
  }

  return { update, reset }
}

// ── Browser adapter ─────────────────────────────────────────────

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model'

let faceapiPromise = null

/** Lazily load face-api and the SSD MobileNet weights (shared with VerificationGate). */
async function defaultDetector(minConfidence) {
  faceapiPromise ??= import('@vladmandic/face-api').then(async faceapi => {
    if (!faceapi.nets.ssdMobilenetv1.isLoaded) {
      await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL)
    }
    return faceapi
  }).catch(err => { faceapiPromise = null; throw err })

  const faceapi = await faceapiPromise
  const opts = new faceapi.SsdMobilenetv1Options({ minConfidence })
  return async videoEl => (await faceapi.detectAllFaces(videoEl, opts))
    .map(d => ({ score: d.score, box: d.box && { x: d.box.x, y: d.box.y, width: d.box.width, height: d.box.height } }))
}

/**
 * Start face monitoring. Returns a stop function immediately; the model
 * loads in the background so other monitors are never held up.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {object} callbacks
 * @param {function} [callbacks.onFaceAbsent]    ({ since, durationMs }) => void
 * @param {function} [callbacks.onFacePresent]   ({ absentMs }) => void
 * @param {function} [callbacks.onMultipleFaces] ({ count, confidence }) => void
 * @param {function} [callbacks.onSingleFace]    () => void
 * @param {function} [callbacks.onReady]         () => void
 * @param {function} [callbacks.onError]         (err) => void
 * @param {object}   [options] FACE_DEFAULTS overrides, plus optional
 *                   `createDetector(minConfidence) => Promise<detect(videoEl)>` for tests
 * @returns {function} stop
 */
export function startFaceMonitor(videoEl, callbacks = {}, options = {}) {
  const { onFaceAbsent, onFacePresent, onMultipleFaces, onSingleFace, onReady, onError, onTiming } = callbacks
  const cfg      = { ...FACE_DEFAULTS, ...options }
  const analyzer = createFaceAnalyzer(cfg)
  const handlers = {
    face_absent:    onFaceAbsent,
    face_present:   onFacePresent,
    multiple_faces: onMultipleFaces,
    single_face:    onSingleFace,
  }

  let stopped = false
  let busy    = false
  let intervalId
  const warned = new Set()

  ;(options.createDetector ?? defaultDetector)(cfg.minConfidence).then(detect => {
    if (stopped) return
    onReady?.()

    async function scan() {
      if (stopped || busy || !videoEl || videoEl.readyState < 2) return
      busy = true
      try {
        const t0 = performance.now()
        const detections = await detect(videoEl)
        if (stopped) return
        const events = analyzer.update(detections, Date.now())
        onTiming?.(performance.now() - t0)   // processing time per frame (ms)
        for (const ev of events) handlers[ev.type]?.(ev)
      } catch (err) {
        // Transient failures (video resizing etc.) are skipped, but surfaced
        // once per distinct message so a persistent fault is not invisible.
        if (!warned.has(err?.message)) { warned.add(err?.message); console.warn('[faceMonitor] detection failed:', err) }
      } finally {
        busy = false
      }
    }

    intervalId = setInterval(scan, cfg.scanIntervalMs)
    scan()
  }, err => { if (!stopped) onError?.(err) })

  return function stop() {
    stopped = true
    clearInterval(intervalId)
  }
}
