// Runs the real YOLOv8n model (onnxruntime-node) through the same
// preprocessing and decoding the browser uses, on real photographs.
// Needs the assets from `npm run test:assets`; skipped if they are missing.

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { rgbaToTensor, analyseOutput, OBJECT_DEFAULTS, INPUT_SIZE } from '../objectMonitor'
import { loadJpeg, letterboxRgba } from './image'

const dir   = path.resolve(import.meta.dirname, '../../../.cache/test-assets')
const model = path.join(dir, 'yolov8n.onnx')
const ready = fs.existsSync(model)

describe.skipIf(!ready)('YOLOv8n on real images (npm run test:assets)', () => {
  let detect

  beforeAll(async () => {
    const ort  = (await import('onnxruntime-node')).default
    const sess = await ort.InferenceSession.create(model)
    detect = async name => {
      const { rgba, lb } = letterboxRgba(loadJpeg(path.join(dir, name)))
      const input  = new ort.Tensor('float32', rgbaToTensor(rgba), [1, 3, INPUT_SIZE, INPUT_SIZE])
      const result = await sess.run({ [sess.inputNames[0]]: input })
      const out    = result[sess.outputNames[0]]
      expect(out.dims).toEqual([1, 84, 8400])
      return analyseOutput(out.data, out.dims, lb, OBJECT_DEFAULTS)
    }
  })

  it('detects a phone held in hand, with a box inside the image', async () => {
    const { objects } = await detect('phone-in-hand.jpg')
    const phones = objects.filter(o => o.className === 'cell phone')
    expect(phones.length).toBeGreaterThanOrEqual(1)
    expect(phones[0].confidence).toBeGreaterThan(0.6)
    const { x, y, width, height } = phones[0].bbox
    expect(x).toBeGreaterThanOrEqual(0)
    expect(y).toBeGreaterThanOrEqual(0)
    expect(x + width).toBeLessThanOrEqual(960 + 1)
    expect(height).toBeGreaterThan(50)
  })

  it('detects phones and several people in a crowded scene', async () => {
    const { objects, persons } = await detect('phones-station.jpg')
    expect(objects.filter(o => o.className === 'cell phone').length).toBeGreaterThanOrEqual(1)
    expect(persons.length).toBeGreaterThanOrEqual(2)
  })

  it('counts multiple people and flags no phone where there is none', async () => {
    const { objects, persons } = await detect('group.jpg')
    expect(persons.length).toBeGreaterThanOrEqual(3)
    expect(objects.filter(o => o.className === 'cell phone')).toEqual([])
  })

  it('reports nothing on a scene with no people or phones', async () => {
    const { objects, persons } = await detect('empty-scene.jpg')
    expect(persons).toEqual([])
    expect(objects).toEqual([])
  })
})
