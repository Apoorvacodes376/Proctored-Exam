import { describe, it, expect, vi } from 'vitest'
import { percentile, summarise, createLatencyRecorder, MAX_SAMPLES_PER_WINDOW } from '../latency'

describe('latency summaries', () => {
  it('uses nearest-rank percentiles', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(xs, 50)).toBe(5)
    expect(percentile(xs, 95)).toBe(10)
    expect(percentile([7], 95)).toBe(7)
    expect(percentile([], 50)).toBeNull()
  })

  it('summarises a window, ignoring non-numbers', () => {
    expect(summarise([30, 10, 20, NaN, 40])).toEqual({ samples: 4, mean_ms: 25, p50_ms: 20, p95_ms: 40, max_ms: 40 })
    expect(summarise([])).toBeNull()
  })
})

describe('createLatencyRecorder', () => {
  it('emits one row per module that had samples, then starts a new window', () => {
    let t = Date.parse('2026-01-01T10:00:00Z')
    const onFlush = vi.fn()
    const rec = createLatencyRecorder({ onFlush, now: () => t })
    rec.record('face', 40); rec.record('face', 60); rec.record('audio', 0.4)
    rec.record('unknown', 5); rec.record('objects', -1)
    t += 60_000
    const rows = rec.flush()
    expect(rows.map(r => r.module)).toEqual(['face', 'audio'])
    expect(rows[0]).toMatchObject({ samples: 2, mean_ms: 50, window_started_at: '2026-01-01T10:00:00.000Z', window_ended_at: '2026-01-01T10:01:00.000Z' })
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(rec.flush()).toEqual([])           // nothing new: no rows, no call
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('caps the samples kept per window', () => {
    const rec = createLatencyRecorder()
    for (let i = 0; i < MAX_SAMPLES_PER_WINDOW + 10; i++) rec.record('objects', 1)
    expect(rec.dropped).toBe(10)
    expect(rec.flush()[0].samples).toBe(MAX_SAMPLES_PER_WINDOW)
  })
})
