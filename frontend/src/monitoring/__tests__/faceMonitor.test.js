import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFaceAnalyzer, startFaceMonitor } from '../faceMonitor'

const face  = (score = 0.9) => ({ score })
const none  = []
const one   = [face()]
const two   = [face(0.95), face(0.8)]

/** Feed a sequence of scans, `stepMs` apart, and collect event types. */
function feed(analyzer, scans, stepMs = 2000) {
  const out = []
  scans.forEach((d, i) => {
    for (const e of analyzer.update(d, i * stepMs)) out.push({ ...e, t: i * stepMs })
  })
  return out
}

describe('createFaceAnalyzer — presence', () => {
  it('does not alert inside the grace period', () => {
    const a = createFaceAnalyzer({ gracePeriodMs: 8000 })
    expect(feed(a, [one, none, none, none, one])).toEqual([])  // absent 6 s
  })

  it('alerts once after the grace period, then once on return', () => {
    const a = createFaceAnalyzer({ gracePeriodMs: 8000 })
    const ev = feed(a, [one, none, none, none, none, none, none, none, one])
    expect(ev.map(e => e.type)).toEqual(['face_absent', 'face_present'])
    expect(ev[0].t).toBe(10_000)               // absent since 2 s, +8 s grace
    expect(ev[0].durationMs).toBe(8000)
    expect(ev[1].absentMs).toBe(14_000)
  })

  it('honours a custom grace period', () => {
    const a = createFaceAnalyzer({ gracePeriodMs: 3000 })
    expect(feed(a, [none, none, none]).map(e => e.type)).toEqual(['face_absent'])
  })

  it('ignores detections below the confidence threshold', () => {
    const a = createFaceAnalyzer({ gracePeriodMs: 2000, minConfidence: 0.6 })
    expect(feed(a, [[face(0.3)], [face(0.3)]]).map(e => e.type)).toEqual(['face_absent'])
  })

  it('starts a new episode after the face returns', () => {
    const a = createFaceAnalyzer({ gracePeriodMs: 2000 })
    const types = feed(a, [none, none, one, none, none, one]).map(e => e.type)
    expect(types).toEqual(['face_absent', 'face_present', 'face_absent', 'face_present'])
  })
})

describe('createFaceAnalyzer — multiple people', () => {
  it('ignores a single-frame second face (glitch / reflection)', () => {
    const a = createFaceAnalyzer()
    expect(feed(a, [one, two, one, one, one])).toEqual([])
  })

  it('reports once when a second person stays, with second-face confidence', () => {
    const a = createFaceAnalyzer()
    const ev = feed(a, [one, two, two, two, two, two])
    expect(ev.map(e => e.type)).toEqual(['multiple_faces'])
    expect(ev[0].count).toBe(2)
    expect(ev[0].confidence).toBe(0.8)
  })

  it('clears after the window has no multi-face scans, and can re-trigger', () => {
    const a = createFaceAnalyzer()
    const types = feed(a, [two, two, one, one, one, two, two]).map(e => e.type)
    expect(types).toEqual(['multiple_faces', 'single_face', 'multiple_faces'])
  })
})

describe('startFaceMonitor (adapter)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const video = { readyState: 4 }

  it('drives callbacks from the injected detector without blocking the caller', async () => {
    const frames = [one, none, none, none, none, none, none, two, two]
    let i = 0
    const detect = vi.fn(async () => frames[Math.min(i++, frames.length - 1)])
    const cb = { onReady: vi.fn(), onFaceAbsent: vi.fn(), onFacePresent: vi.fn(), onMultipleFaces: vi.fn() }

    const stop = startFaceMonitor(video, cb, { createDetector: async () => detect, gracePeriodMs: 8000 })
    expect(typeof stop).toBe('function')        // returned synchronously
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onReady).toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(16_000)
    expect(cb.onFaceAbsent).toHaveBeenCalledTimes(1)
    expect(cb.onFacePresent).toHaveBeenCalledTimes(1)
    expect(cb.onMultipleFaces).toHaveBeenCalledTimes(1)
    stop()

    const calls = detect.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(detect.mock.calls.length).toBe(calls)  // stopped
  })

  it('skips scans while the video is not ready', async () => {
    const detect = vi.fn(async () => one)
    const stop = startFaceMonitor({ readyState: 0 }, {}, { createDetector: async () => detect })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(detect).not.toHaveBeenCalled()
    stop()
  })

  it('reports model load failure via onError', async () => {
    const onError = vi.fn()
    startFaceMonitor(video, { onError }, { createDetector: () => Promise.reject(new Error('offline')) })
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' }))
  })
})
