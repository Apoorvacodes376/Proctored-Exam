/**
 * heartbeat.js
 * Sends the student's live monitoring status to the faculty dashboard
 * (via the report_live_status RPC → Realtime). Sends on a fixed interval
 * so faculty can tell the student is still connected, and promptly —
 * but throttled — when the status changes.
 *
 * No React, no Supabase: `send(status)` is injected.
 */

export const HEARTBEAT_DEFAULTS = {
  intervalMs: 10_000,   // keep-alive; faculty treat >30 s of silence as offline
  minGapMs:    2_000,   // at most one change-triggered send per 2 s
}

/** The fields faculty see. Anything else in the hook's status is local UI state. */
export function liveFields(status) {
  return {
    camera:     status.camera,
    microphone: status.microphone,
    face:       status.face,
    objects:    status.objects,
    audio:      status.audio,
    away:       !!status.away,
    logging:    status.logging,
  }
}

/**
 * @param {object}   opts
 * @param {function} opts.send        async (fields) => void
 * @param {number}   [opts.intervalMs]
 * @param {number}   [opts.minGapMs]
 * @param {function} [opts.onError]
 */
export function createHeartbeat({ send, intervalMs = HEARTBEAT_DEFAULTS.intervalMs, minGapMs = HEARTBEAT_DEFAULTS.minGapMs, onError }) {
  let latest   = null
  let lastSent = null      // JSON of last sent fields
  let lastAt   = -Infinity
  let pending  = null      // timeout for a throttled change
  let inFlight = false
  let stopped  = false

  async function flush() {
    pending = null
    if (stopped || !latest || inFlight) return
    inFlight = true
    const body = latest
    lastAt = Date.now()
    try {
      await send(body)
      lastSent = JSON.stringify(body)
    } catch (err) {
      onError?.(err)
    } finally {
      inFlight = false
    }
  }

  const tick = setInterval(flush, intervalMs)

  return {
    /** Report the current status; sends soon if it changed. */
    update(status) {
      latest = liveFields(status)
      if (stopped || JSON.stringify(latest) === lastSent || pending) return
      const wait = Math.max(0, lastAt + minGapMs - Date.now())
      pending = setTimeout(flush, wait)
    },
    stop() {
      stopped = true
      clearInterval(tick)
      clearTimeout(pending)
    },
  }
}
