/**
 * streamMonitor.js
 * Module 5: Camera & Microphone Status
 *
 * Watches the camera and microphone tracks of a MediaStream and reports
 * each continuous interruption exactly once:
 *   onLost(kind, reason)        kind: 'camera' | 'microphone'
 *   onRestored(kind, downtimeMs)
 *
 * reason is one of:
 *   'missing'            no track of that kind in the stream (not granted / no device)
 *   'ended'              track stopped (device unplugged, permission revoked,
 *                        another app took the device, OS privacy switch)
 *   'muted'              browser/OS stopped delivering frames/samples (e.g. a
 *                        hardware privacy shutter or the OS mic mute on some
 *                        platforms) — may recover by itself
 *   'permission_revoked' Permissions API reports the permission was withdrawn
 *
 * An ended track never comes back; the caller must request a new stream and
 * start a new monitor (useProctoring does this via "Reconnect").
 *
 * Browser limitations: not every OS-level mute is visible to the page — a
 * physical camera cover or a muted headset may still deliver black frames
 * or silence while the track reports "live". Face presence and audio level
 * are the backstop for those cases.
 *
 * Detection uses track events plus a poll, because not all browsers fire
 * 'mute'/'ended' reliably. No React, no Supabase.
 */

const POLL_MS = 2_000

/**
 * @param {MediaStream} stream
 * @param {object} callbacks
 * @param {function} [callbacks.onLost]      (kind, reason) => void
 * @param {function} [callbacks.onRestored]  (kind, downtimeMs) => void
 * @param {object}   [options]
 * @param {Permissions} [options.permissions]  defaults to navigator.permissions
 * @param {number}      [options.pollMs]
 * @returns {function} stop
 */
export function startStreamMonitor(stream, { onLost, onRestored } = {}, options = {}) {
  const permissions = options.permissions !== undefined ? options.permissions : globalThis.navigator?.permissions
  const pollMs = options.pollMs ?? POLL_MS

  let stopped = false
  const cleanups = []

  const channels = {
    camera:     { track: stream?.getVideoTracks?.()[0] ?? null, perm: 'camera',     revoked: false, lostAt: null },
    microphone: { track: stream?.getAudioTracks?.()[0] ?? null, perm: 'microphone', revoked: false, lostAt: null },
  }

  function reasonFor(ch) {
    if (!ch.track)                       return 'missing'
    if (ch.revoked)                      return 'permission_revoked'
    if (ch.track.readyState === 'ended') return 'ended'
    if (ch.track.muted)                  return 'muted'
    return null
  }

  function evaluate(kind) {
    if (stopped) return
    const ch = channels[kind]
    const reason = reasonFor(ch)
    if (reason && ch.lostAt === null) {
      ch.lostAt = Date.now()
      onLost?.(kind, reason)
    } else if (!reason && ch.lostAt !== null) {
      const downtime = Date.now() - ch.lostAt
      ch.lostAt = null
      onRestored?.(kind, downtime)
    }
  }

  for (const [kind, ch] of Object.entries(channels)) {
    if (ch.track) {
      const handler = () => evaluate(kind)
      for (const type of ['ended', 'mute', 'unmute']) {
        ch.track.addEventListener(type, handler)
        cleanups.push(() => ch.track.removeEventListener(type, handler))
      }
    }

    // Permission withdrawal (Chrome/Edge/Firefox support querying camera &
    // microphone; Safari may throw — then we rely on track state alone).
    permissions?.query?.({ name: ch.perm }).then(status => {
      if (stopped) return
      const update = () => {
        ch.revoked = status.state === 'denied'
        evaluate(kind)
      }
      status.addEventListener?.('change', update)
      cleanups.push(() => status.removeEventListener?.('change', update))
      update()
    }, () => { /* unsupported permission name */ })
  }

  const pollId = setInterval(() => { evaluate('camera'); evaluate('microphone') }, pollMs)
  evaluate('camera')
  evaluate('microphone')

  return function stop() {
    stopped = true
    clearInterval(pollId)
    cleanups.forEach(fn => fn())
  }
}
