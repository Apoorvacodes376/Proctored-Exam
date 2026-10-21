/**
 * streamMonitor.js
 * Module 5: Camera & Microphone Status Monitoring
 *
 * Polls MediaStreamTrack.readyState and .muted at a regular interval.
 * Fires callbacks on state transitions only (not on every poll tick),
 * preventing duplicate alerts during a single continuous interruption.
 *
 * Fully independent — no React, no Supabase.
 */

const POLL_MS = 2_000

/**
 * Start stream status monitoring.
 *
 * @param {MediaStream} stream
 * @param {object} callbacks
 * @param {function} callbacks.onCameraLost     () => void
 * @param {function} callbacks.onCameraRestored () => void
 * @param {function} callbacks.onMicLost        () => void
 * @param {function} callbacks.onMicRestored    () => void
 * @returns {function} stop
 */
export function startStreamMonitor(stream, { onCameraLost, onCameraRestored, onMicLost, onMicRestored }) {
  let stopped = false

  const videoTrack = stream.getVideoTracks()[0] ?? null
  const audioTrack = stream.getAudioTracks()[0] ?? null

  // Track last known states to detect transitions.
  let camOk = videoTrack ? (videoTrack.readyState === 'live' && !videoTrack.muted) : false
  let micOk = audioTrack ? (audioTrack.readyState === 'live' && !audioTrack.muted) : false

  function checkTrack(track, wasOk, onLost, onRestored) {
    if (!track) return wasOk
    const isOk = track.readyState === 'live' && !track.muted
    if (wasOk && !isOk) { onLost?.() }
    if (!wasOk && isOk) { onRestored?.() }
    return isOk
  }

  const pollId = setInterval(() => {
    if (stopped) return
    camOk = checkTrack(videoTrack, camOk, onCameraLost, onCameraRestored)
    micOk = checkTrack(audioTrack, micOk, onMicLost,    onMicRestored)
  }, POLL_MS)

  // Also listen to native 'ended' events for immediate notification.
  function handleVideoEnded() { if (!stopped && camOk) { camOk = false; onCameraLost?.() } }
  function handleAudioEnded() { if (!stopped && micOk) { micOk = false; onMicLost?.()   } }

  videoTrack?.addEventListener('ended', handleVideoEnded)
  audioTrack?.addEventListener('ended', handleAudioEnded)

  return function stop() {
    stopped = true
    clearInterval(pollId)
    videoTrack?.removeEventListener('ended', handleVideoEnded)
    audioTrack?.removeEventListener('ended', handleAudioEnded)
  }
}
