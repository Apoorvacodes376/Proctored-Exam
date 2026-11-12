/**
 * latency.js
 * Collects per-module processing times (ms, from performance.now() in the
 * monitors' onTiming callbacks) and turns each reporting window into one
 * summary row for public.monitoring_performance.
 *
 * These are real measurements, but of the student's own device and
 * browser: they vary with hardware, other open tabs and thermal state,
 * and background tabs are throttled by the browser.
 */

export const LATENCY_MODULES = ['face', 'objects', 'audio']
export const MAX_SAMPLES_PER_WINDOW = 5_000

/** Nearest-rank percentile of an ascending array (p in 0..100). */
export function percentile(sorted, p) {
  if (!sorted.length) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

/** { samples, mean_ms, p50_ms, p95_ms, max_ms } or null for no samples. */
export function summarise(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!xs.length) return null
  const round = x => Math.round(x * 100) / 100
  return {
    samples: xs.length,
    mean_ms: round(xs.reduce((s, x) => s + x, 0) / xs.length),
    p50_ms:  round(percentile(xs, 50)),
    p95_ms:  round(percentile(xs, 95)),
    max_ms:  round(xs[xs.length - 1]),
  }
}

/**
 * @param {object} opts
 * @param {(rows: object[]) => Promise<void>|void} opts.onFlush  receives summary rows
 * @param {number}   [opts.windowMs=60000]
 * @param {() => number} [opts.now]   wall clock (ms)
 */
export function createLatencyRecorder({ onFlush, windowMs = 60_000, now = Date.now } = {}) {
  let samples = Object.fromEntries(LATENCY_MODULES.map(m => [m, []]))
  let windowStart = now()
  let dropped = 0
  let timer = null

  function record(module, ms) {
    const bucket = samples[module]
    if (!bucket || !Number.isFinite(ms) || ms < 0) return
    if (bucket.length >= MAX_SAMPLES_PER_WINDOW) { dropped++; return }
    bucket.push(ms)
  }

  /** Summarise and reset the current window. Returns the rows. */
  function flush() {
    const end = now()
    const rows = []
    for (const module of LATENCY_MODULES) {
      const s = summarise(samples[module])
      if (s) rows.push({
        module, ...s,
        window_started_at: new Date(windowStart).toISOString(),
        window_ended_at:   new Date(end).toISOString(),
      })
    }
    samples = Object.fromEntries(LATENCY_MODULES.map(m => [m, []]))
    windowStart = end
    dropped = 0
    if (rows.length) onFlush?.(rows)
    return rows
  }

  return {
    record,
    flush,
    start() { if (!timer) timer = setInterval(flush, windowMs) },
    stop()  { clearInterval(timer); timer = null; return flush() },
    get dropped() { return dropped },
  }
}

/** Coarse, non-identifying device description stored with the summaries. */
export function deviceInfo(nav = globalThis.navigator) {
  if (!nav) return null
  return {
    cores:     nav.hardwareConcurrency ?? null,
    memory_gb: nav.deviceMemory ?? null,
    platform:  nav.userAgentData?.platform ?? null,
    mobile:    nav.userAgentData?.mobile ?? null,
    browser:   nav.userAgentData?.brands?.map(b => `${b.brand} ${b.version}`).join(', ').slice(0, 120) ?? null,
  }
}
