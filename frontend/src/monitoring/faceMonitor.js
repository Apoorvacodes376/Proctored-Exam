/**
 * faceMonitor.js
 * Module 1 & 2: Face Presence + Multiple-Person Detection
 *
 * Uses @vladmandic/face-api (already loaded by VerificationGate).
 * Runs SSD MobileNet detection on a <video> element at a configurable
 * interval. Emits callbacks for:
 *   - face_absent  : no face detected for > GRACE_PERIOD_MS
 *   - face_present : face returns after absence
 *   - multiple_faces: more than one face detected
 *
 * Fully independent — no React, no Supabase. Testable in isolation.
 */

import * as faceapi from '@vladmandic/face-api'

const MODEL_URL       = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model'
const SCAN_INTERVAL   = 3_000   // ms between detection runs
const GRACE_PERIOD_MS = 8_000   // ms face must be absent before alert fires

let modelsReady = false

async function ensureModels() {
  if (modelsReady) return
  // SSD MobileNet is sufficient for presence/count — no landmarks needed here.
  if (!faceapi.nets.ssdMobilenetv1.isLoaded) {
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL)
  }
  modelsReady = true
}

/**
 * Start face monitoring on a video element.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {object} callbacks
 * @param {function} callbacks.onFaceAbsent    (durationMs: number) => void
 * @param {function} callbacks.onFacePresent   () => void
 * @param {function} callbacks.onMultipleFaces (count: number, confidence: number) => void
 * @returns {function} stop — call to halt monitoring
 */
export async function startFaceMonitor(videoEl, { onFaceAbsent, onFacePresent, onMultipleFaces }) {
  await ensureModels()

  let absentSince   = null   // timestamp when face first disappeared
  let wasAbsent     = false
  let alertedAbsent = false
  let stopped       = false

  async function scan() {
    if (stopped || !videoEl || videoEl.readyState < 2) return

    let detections = []
    try {
      detections = await faceapi.detectAllFaces(
        videoEl,
        new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 })
      )
    } catch {
      // Detection can fail transiently (e.g. video not ready) — skip silently.
      return
    }

    const count = detections.length

    if (count === 0) {
      if (!absentSince) absentSince = Date.now()
      const duration = Date.now() - absentSince

      if (duration >= GRACE_PERIOD_MS && !alertedAbsent) {
        alertedAbsent = true
        wasAbsent     = true
        onFaceAbsent?.(duration)
      }
    } else {
      if (wasAbsent) {
        wasAbsent     = false
        alertedAbsent = false
        onFacePresent?.()
      }
      absentSince   = null
      alertedAbsent = false

      if (count > 1) {
        // Confidence = average score of all detections.
        const avgConf = detections.reduce((s, d) => s + (d.score ?? 0.8), 0) / count
        onMultipleFaces?.(count, avgConf)
      }
    }
  }

  const intervalId = setInterval(scan, SCAN_INTERVAL)
  // Run immediately so first result isn't delayed.
  scan()

  return function stop() {
    stopped = true
    clearInterval(intervalId)
  }
}
