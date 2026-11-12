import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  letterbox, rgbaToTensor, decodeYolo, iou, nms, analyseOutput, startObjectMonitor, OBJECT_DEFAULTS,
} from '../objectMonitor'

/** Build a synthetic YOLOv8 output [1, 84, N] from a list of boxes. */
function yoloOutput(boxes, numBoxes = 16) {
  const rows = 84
  const data = new Float32Array(rows * numBoxes)
  boxes.forEach(({ cx, cy, w, h, classId, score }, b) => {
    data[b] = cx; data[numBoxes + b] = cy; data[2 * numBoxes + b] = w; data[3 * numBoxes + b] = h
    data[(4 + classId) * numBoxes + b] = score
  })
  return { data, dims: [1, rows, numBoxes] }
}

describe('letterbox', () => {
  it('fits a 640×480 webcam frame with vertical padding', () => {
    expect(letterbox(640, 480)).toEqual({ scale: 1, w: 640, h: 480, padX: 0, padY: 80, size: 640 })
  })
  it('fits a 1280×720 frame', () => {
    const lb = letterbox(1280, 720)
    expect(lb.scale).toBe(0.5)
    expect([lb.w, lb.h, lb.padX, lb.padY]).toEqual([640, 360, 0, 140])
  })
})

describe('rgbaToTensor', () => {
  it('converts RGBA to normalised planar RGB', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 51, 102, 153, 255])
    const t = rgbaToTensor(rgba, 2)
    const want = [1, 0, 0, 0.2, 0, 1, 0, 0.4, 0, 0, 1, 0.6]
    want.forEach((v, i) => expect(t[i]).toBeCloseTo(v, 6))
  })
})

describe('decodeYolo / nms', () => {
  const phone = c => (c === 67 ? 0.4 : undefined)

  it('keeps only requested classes above their threshold', () => {
    const { data, dims } = yoloOutput([
      { cx: 100, cy: 100, w: 20, h: 40, classId: 67, score: 0.8 },   // phone
      { cx: 300, cy: 300, w: 20, h: 40, classId: 67, score: 0.3 },   // weak phone
      { cx: 200, cy: 200, w: 50, h: 50, classId: 2,  score: 0.9 },   // car — ignored
    ])
    const dets = decodeYolo(data, dims, { threshold: phone })
    expect(dets).toHaveLength(1)
    expect(dets[0].classId).toBe(67)
    expect(dets[0].confidence).toBeCloseTo(0.8)
    expect(dets[0].bbox).toEqual({ x: 90, y: 80, width: 20, height: 40 })
  })

  it('maps boxes back through the letterbox to source pixels', () => {
    const lb = letterbox(1280, 720)             // scale 0.5, padY 140
    const { data, dims } = yoloOutput([{ cx: 320, cy: 320, w: 64, h: 32, classId: 67, score: 0.9 }])
    const [d] = decodeYolo(data, dims, { threshold: phone, lb })
    expect(d.bbox).toEqual({ x: 576, y: 328, width: 128, height: 64 })
  })

  it('iou is 1 for identical boxes and 0 for disjoint ones', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 }
    expect(iou(a, a)).toBe(1)
    expect(iou(a, { x: 20, y: 20, width: 5, height: 5 })).toBe(0)
  })

  it('suppresses overlapping boxes of the same class but not of different classes', () => {
    const b = (x, classId, confidence) => ({ classId, confidence, bbox: { x, y: 0, width: 100, height: 100 } })
    const kept = nms([b(0, 67, 0.6), b(5, 67, 0.9), b(300, 67, 0.5), b(2, 0, 0.8)])
    expect(kept.map(k => [k.classId, k.confidence])).toEqual([[67, 0.9], [0, 0.8], [67, 0.5]])
  })
})

describe('analyseOutput', () => {
  it('separates flagged objects from person count, with class names', () => {
    const { data, dims } = yoloOutput([
      { cx: 100, cy: 100, w: 40, h: 80,   classId: 67, score: 0.85 },
      { cx: 102, cy: 101, w: 40, h: 80,   classId: 67, score: 0.70 },  // duplicate box
      { cx: 200, cy: 300, w: 150, h: 300, classId: 0,  score: 0.90 },
      { cx: 480, cy: 300, w: 150, h: 300, classId: 0,  score: 0.75 },
      { cx: 400, cy: 400, w: 60, h: 60,   classId: 73, score: 0.45 },  // book below its 0.5
    ])
    const { objects, persons } = analyseOutput(data, dims, null, OBJECT_DEFAULTS)
    expect(objects).toHaveLength(1)
    expect(objects[0].className).toBe('cell phone')
    expect(persons).toHaveLength(2)
  })
})

describe('startObjectMonitor (adapter)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const video = { readyState: 4 }

  it('returns immediately, then reports objects and person counts per scan', async () => {
    const out = yoloOutput([
      { cx: 100, cy: 100, w: 40, h: 80,   classId: 67, score: 0.9 },
      { cx: 200, cy: 300, w: 150, h: 300, classId: 0,  score: 0.8 },
    ])
    const run = vi.fn(async () => ({ ...out, lb: null }))
    const cb = { onReady: vi.fn(), onObjectDetected: vi.fn(), onPersons: vi.fn() }
    const stop = startObjectMonitor(video, cb, { createRunner: async () => run, scanIntervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(2500)

    expect(cb.onReady).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledTimes(3)
    expect(cb.onObjectDetected).toHaveBeenCalledWith(expect.objectContaining({ className: 'cell phone' }))
    expect(cb.onPersons).toHaveBeenLastCalledWith({ count: 1, confidence: expect.closeTo(0.8) })
    stop()
  })

  it('skips a scan while the previous inference is still running', async () => {
    let resolve
    const run = vi.fn(() => new Promise(r => { resolve = r }))
    const stop = startObjectMonitor(video, {}, { createRunner: async () => run, scanIntervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(run).toHaveBeenCalledTimes(1)
    resolve({ ...yoloOutput([]), lb: null })
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(2)
    stop()
  })

  it('reports a model load failure and never scans', async () => {
    const onError = vi.fn()
    startObjectMonitor(video, { onError }, { createRunner: () => Promise.reject(new Error('404')) })
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: '404' }))
  })
})
