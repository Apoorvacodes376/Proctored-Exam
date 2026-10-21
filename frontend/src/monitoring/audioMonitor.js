/**
 * audioMonitor.js
 * Module 4: Audio Monitoring
 *
 * Uses the Web Audio API (no external library needed).
 *
 * Detects:
 *  - Microphone availability / interruption (track ended / muted)
 *  - Voice Activity Detection (VAD) via RMS energy threshold
 *  - Sustained speech vs. brief noise (speech requires energy above
 *    threshold for > SPEECH_SUSTAIN_MS continuously)
 *
 * Browser limitation: Web Audio cannot distinguish whose voice is
 * speaking or identify specific words. It can only detect that audio
 * energy above a threshold is present. This is disclosed to the caller
 * via the callback label ('speech' vs 'noise').
 *
 * Fully independent — no React, no Supabase.
 */

const FFT_SIZE          = 256
const NOISE_THRESH_RMS  = 0.015   // RMS amplitude 0–1; below = silence
const SPEECH_THRESH_RMS = 0.04    // above = likely speech (not just ambient)
const SPEECH_SUSTAIN_MS = 1_500   // must stay above speech threshold this long
const POLL_INTERVAL_MS  = 200     // how often we sample RMS

/**
 * Compute RMS of a Float32Array audio buffer.
 */
function rms(buffer) {
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i]
  return Math.sqrt(sum / buffer.length)
}

/**
 * Start audio monitoring on a MediaStream.
 *
 * @param {MediaStream} stream  — must contain an audio track
 * @param {object} callbacks
 * @param {function} callbacks.onSpeechDetected  (type: 'speech'|'noise') => void
 * @param {function} callbacks.onSilence         () => void
 * @param {function} callbacks.onMicInterrupted  () => void
 * @param {function} callbacks.onMicRestored     () => void
 * @returns {function} stop
 */
export function startAudioMonitor(stream, { onSpeechDetected, onSilence, onMicInterrupted, onMicRestored }) {
  const audioTrack = stream.getAudioTracks()[0]
  if (!audioTrack) {
    // No audio track — report immediately and return no-op.
    onMicInterrupted?.()
    return () => {}
  }

  let stopped        = false
  let micWasOk       = true
  let speechStart    = null   // timestamp when energy first exceeded speech threshold
  let speechAlerted  = false
  let silenceAlerted = true   // start as "silent" so first speech fires correctly

  // ── Track-level interruption detection ───────────────────
  function handleTrackEnded() {
    if (stopped) return
    micWasOk = false
    onMicInterrupted?.()
  }

  audioTrack.addEventListener('ended', handleTrackEnded)

  // ── Web Audio VAD ─────────────────────────────────────────
  let audioCtx, analyser, source, pollId

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = FFT_SIZE
    source   = audioCtx.createMediaStreamSource(stream)
    source.connect(analyser)

    const buffer = new Float32Array(analyser.fftSize)

    pollId = setInterval(() => {
      if (stopped) return

      // Check track state each poll cycle.
      const trackLive = audioTrack.readyState === 'live' && !audioTrack.muted
      if (!trackLive && micWasOk) {
        micWasOk = false
        onMicInterrupted?.()
      } else if (trackLive && !micWasOk) {
        micWasOk = true
        onMicRestored?.()
      }

      analyser.getFloatTimeDomainData(buffer)
      const level = rms(buffer)

      if (level < NOISE_THRESH_RMS) {
        // Silence
        speechStart   = null
        speechAlerted = false
        if (!silenceAlerted) {
          silenceAlerted = true
          onSilence?.()
        }
        return
      }

      silenceAlerted = false

      if (level >= SPEECH_THRESH_RMS) {
        if (!speechStart) speechStart = Date.now()
        const sustained = Date.now() - speechStart

        if (sustained >= SPEECH_SUSTAIN_MS && !speechAlerted) {
          speechAlerted = true
          onSpeechDetected?.('speech')
        }
      } else {
        // Noise level (above silence, below speech)
        speechStart   = null
        speechAlerted = false
        onSpeechDetected?.('noise')
      }
    }, POLL_INTERVAL_MS)
  } catch (err) {
    console.warn('[audioMonitor] Web Audio setup failed:', err.message)
  }

  return function stop() {
    stopped = true
    clearInterval(pollId)
    audioTrack.removeEventListener('ended', handleTrackEnded)
    try { source?.disconnect(); audioCtx?.close() } catch {}
  }
}
