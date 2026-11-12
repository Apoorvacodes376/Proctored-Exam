/**
 * audioMonitor.js
 * Module 4: Audio Monitoring
 *
 * Browser adapter around vad.js: pulls ~43 ms time-domain frames from a
 * Web Audio AnalyserNode every 100 ms and runs them through the voice
 * activity detector, which distinguishes:
 *   - speech          (voiced, harmonic, syllabically modulated sound)
 *   - unusual noise   (loud, non-speech: bangs, ringtones, a vacuum)
 *   - background      (steady noise the adaptive floor absorbs — not reported)
 *
 * Microphone availability / interruption is handled by streamMonitor.js,
 * so a lost mic is reported once rather than by two modules.
 *
 * Browser limitations (see also vad.js):
 *   - Browsers may apply noise suppression / auto-gain to the mic stream,
 *     which changes levels; the detector adapts but thresholds are relative.
 *   - An AudioContext may start "suspended" until the page has had a user
 *     gesture. We try to resume and report the state via onStateChange.
 *
 * No React, no Supabase.
 */

import { createVoiceActivityDetector } from './vad'

const FFT_SIZE         = 2048
const POLL_INTERVAL_MS = 100

/**
 * @param {MediaStream} stream — must contain an audio track
 * @param {object} callbacks
 * @param {function} [callbacks.onSpeechStart]   ({ confidence, at }) => void
 * @param {function} [callbacks.onSpeechEnd]     ({ durationMs, at }) => void
 * @param {function} [callbacks.onNoiseStart]    ({ peakDb, aboveFloorDb, at }) => void
 * @param {function} [callbacks.onNoiseEnd]      ({ durationMs, at }) => void
 * @param {function} [callbacks.onStateChange]   ('running'|'suspended'|'unavailable', detail?) => void
 * @param {object}   [options]
 * @param {Function} [options.AudioContext]      injectable for tests
 * @param {object}   [options.vad]               overrides for VAD_DEFAULTS
 * @returns {function} stop
 */
export function startAudioMonitor(stream, callbacks = {}, options = {}) {
  const { onSpeechStart, onSpeechEnd, onNoiseStart, onNoiseEnd, onStateChange, onTiming } = callbacks

  if (!stream?.getAudioTracks?.().length) {
    onStateChange?.('unavailable', 'no audio track')
    return () => {}
  }

  const Ctx = options.AudioContext ?? globalThis.AudioContext ?? globalThis.webkitAudioContext
  if (!Ctx) {
    onStateChange?.('unavailable', 'Web Audio not supported')
    return () => {}
  }

  let audioCtx, source, pollId
  let stopped = false
  let lastState = null

  function reportState() {
    const s = audioCtx?.state === 'running' ? 'running' : 'suspended'
    if (s !== lastState) { lastState = s; onStateChange?.(s) }
  }

  // Autoplay policy can leave the context suspended; resume on the next
  // interaction with the page.
  function resumeOnGesture() {
    if (audioCtx?.state === 'suspended') audioCtx.resume().then(reportState, () => {})
  }

  try {
    audioCtx = new Ctx()
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = FFT_SIZE
    analyser.smoothingTimeConstant = 0
    source = audioCtx.createMediaStreamSource(stream)
    source.connect(analyser)

    const vad    = createVoiceActivityDetector({ sampleRate: audioCtx.sampleRate, ...options.vad })
    const buffer = new Float32Array(FFT_SIZE)

    const handlers = {
      speech_start: onSpeechStart,
      speech_end:   onSpeechEnd,
      noise_start:  onNoiseStart,
      noise_end:    onNoiseEnd,
    }

    pollId = setInterval(() => {
      if (stopped) return
      reportState()
      if (audioCtx.state !== 'running') return
      const t0 = performance.now()
      analyser.getFloatTimeDomainData(buffer)
      const events = vad.process(buffer, Date.now())
      onTiming?.(performance.now() - t0)   // FFT + VAD per window (ms)
      for (const ev of events) handlers[ev.type]?.(ev)
    }, POLL_INTERVAL_MS)

    if (audioCtx.state === 'suspended') audioCtx.resume?.().catch(() => {})
    globalThis.addEventListener?.('pointerdown', resumeOnGesture)
    globalThis.addEventListener?.('keydown', resumeOnGesture)
    reportState()
  } catch (err) {
    onStateChange?.('unavailable', err.message)
    return () => {}
  }

  return function stop() {
    stopped = true
    clearInterval(pollId)
    globalThis.removeEventListener?.('pointerdown', resumeOnGesture)
    globalThis.removeEventListener?.('keydown', resumeOnGesture)
    try { source?.disconnect(); audioCtx?.close() } catch { /* already closed */ }
  }
}
