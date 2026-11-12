/**
 * objectMonitor.js
 * Module 3: Object Detection (phones / prohibited items) + person count
 *
 * Runs a COCO-trained YOLOv8n (ONNX, ~12.8 MB, float32) in the browser via
 * ONNX Runtime Web (WebAssembly). The model URL is configurable with
 * VITE_YOLO_MODEL_URL so it can be self-hosted (recommended for exams).
 *
 * Pure, testable parts:
 *   letterbox()        — geometry for aspect-preserving resize to 640×640
 *   rgbaToTensor()     — RGBA pixels → normalised CHW float32
 *   decodeYolo()       — [1, 84, N] output → boxes in source-pixel coords
 *   nms()              — per-class non-maximum suppression
 *
 * Reports, per scan:
 *   onObjectDetected({ classId, className, confidence, bbox })  flagged classes
 *   onPersons({ count, confidence })                             'person' count,
 *       used as a second signal for multiple-person detection
 *
 * Limitations, stated honestly:
 *   - Only objects visible to the webcam can be detected; a phone below the
 *     desk, a second monitor out of frame, earbuds, smart watches or other
 *     applications on the computer cannot be seen this way.
 *   - COCO "cell phone" is a general class; a dark phone held edge-on or
 *     partly hidden is often missed, and some rectangles (remotes, wallets)
 *     can be mistaken for one. Every detection carries its confidence and
 *     a snapshot for human review — it is evidence, not a verdict.
 *   - Inference runs on the main thread via WASM; slow devices simply scan
 *     less often (a scan is skipped while the previous one is still running).
 *
 * YOLOv8 weights are released by Ultralytics under AGPL-3.0.
 * No React, no Supabase.
 */

export const INPUT_SIZE = 640

// Pinned revision of a standard Ultralytics YOLOv8n COCO export.
export const DEFAULT_MODEL_URL =
  'https://huggingface.co/webml/yolov8n/resolve/85bc8d7ab30d4065a41909d756c42819b67b4388/onnx/yolov8n.onnx'

const ORT_VERSION = '1.18.0'
const ORT_CDN     = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`

export const PERSON_CLASS = 0

/** COCO classes flagged by default, with per-class confidence thresholds. */
export const DEFAULT_FLAGGED = {
  67: { name: 'cell phone', minConfidence: 0.40 },
  73: { name: 'book',       minConfidence: 0.50 },
}

export const OBJECT_DEFAULTS = {
  scanIntervalMs:   4_000,
  iouThreshold:      0.45,
  personMinConfidence: 0.5,
  flagged: DEFAULT_FLAGGED,
}

// ── Pure helpers ────────────────────────────────────────────────

/** Aspect-preserving fit of a srcW×srcH frame into a size×size square. */
export function letterbox(srcW, srcH, size = INPUT_SIZE) {
  const scale = Math.min(size / srcW, size / srcH)
  const w = Math.round(srcW * scale)
  const h = Math.round(srcH * scale)
  return { scale, w, h, padX: Math.floor((size - w) / 2), padY: Math.floor((size - h) / 2), size }
}

/** RGBA Uint8ClampedArray (size×size) → Float32Array CHW in [0, 1]. */
export function rgbaToTensor(rgba, size = INPUT_SIZE) {
  const area = size * size
  const out  = new Float32Array(3 * area)
  for (let i = 0; i < area; i++) {
    out[i]            = rgba[i * 4]     / 255
    out[area + i]     = rgba[i * 4 + 1] / 255
    out[2 * area + i] = rgba[i * 4 + 2] / 255
  }
  return out
}

/**
 * Decode a YOLOv8 detection head output.
 * @param {Float32Array} data  flattened [1, 4 + numClasses, numBoxes]
 * @param {number[]} dims      tensor dims, e.g. [1, 84, 8400]
 * @param {object} opts
 * @param {(classId:number) => number|undefined} opts.threshold  min confidence for a class,
 *        or undefined to ignore that class
 * @param {object} [opts.lb]   letterbox() result, to map boxes back to source pixels
 * @returns {{classId:number, confidence:number, bbox:{x:number,y:number,width:number,height:number}}[]}
 */
export function decodeYolo(data, dims, { threshold, lb }) {
  const [, rows, numBoxes] = dims
  const numClasses = rows - 4
  const out = []
  for (let b = 0; b < numBoxes; b++) {
    let best = 0, classId = -1
    for (let c = 0; c < numClasses; c++) {
      const s = data[(4 + c) * numBoxes + b]
      if (s > best) { best = s; classId = c }
    }
    const min = threshold(classId)
    if (min === undefined || best < min) continue

    const cx = data[b], cy = data[numBoxes + b], w = data[2 * numBoxes + b], h = data[3 * numBoxes + b]
    let x = cx - w / 2, y = cy - h / 2, width = w, height = h
    if (lb) {
      x = (x - lb.padX) / lb.scale; y = (y - lb.padY) / lb.scale
      width /= lb.scale;            height /= lb.scale
    }
    out.push({ classId, confidence: best, bbox: { x, y, width, height } })
  }
  return out
}

export function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = a.width * a.height + b.width * b.height - inter
  return union > 0 ? inter / union : 0
}

/** Greedy per-class non-maximum suppression. */
export function nms(dets, iouThreshold = OBJECT_DEFAULTS.iouThreshold) {
  const sorted = [...dets].sort((a, b) => b.confidence - a.confidence)
  const keep = []
  for (const d of sorted) {
    if (keep.every(k => k.classId !== d.classId || iou(k.bbox, d.bbox) < iouThreshold)) keep.push(d)
  }
  return keep
}

/**
 * Turn raw model output into the monitor's per-scan result.
 * Shared by the browser adapter and the real-model test.
 */
export function analyseOutput(data, dims, lb, cfg = OBJECT_DEFAULTS) {
  const threshold = c =>
    c === PERSON_CLASS ? cfg.personMinConfidence : cfg.flagged[c]?.minConfidence
  const kept    = nms(decodeYolo(data, dims, { threshold, lb }), cfg.iouThreshold)
  const persons = kept.filter(d => d.classId === PERSON_CLASS)
  const objects = kept
    .filter(d => d.classId !== PERSON_CLASS)
    .map(d => ({ ...d, className: cfg.flagged[d.classId].name }))
  return { objects, persons }
}

// ── Browser adapter ─────────────────────────────────────────────

let ortPromise     = null
const sessionCache = new Map()

function loadOrt() {
  ortPromise ??= new Promise((resolve, reject) => {
    if (globalThis.ort) return resolve(globalThis.ort)
    const s = document.createElement('script')
    s.src     = `${ORT_CDN}ort.min.js`
    s.onload  = () => globalThis.ort ? resolve(globalThis.ort) : reject(new Error('onnxruntime-web did not initialise'))
    s.onerror = () => reject(new Error('Failed to load ONNX Runtime Web'))
    document.head.appendChild(s)
  }).catch(err => { ortPromise = null; throw err })
  return ortPromise
}

async function defaultRunner(modelUrl) {
  const ort = await loadOrt()
  ort.env.wasm.wasmPaths = ORT_CDN
  let session = sessionCache.get(modelUrl)
  if (!session) {
    session = ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
    sessionCache.set(modelUrl, session)
    session.catch(() => sessionCache.delete(modelUrl))
  }
  const sess = await session

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = INPUT_SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  return async videoEl => {
    const lb = letterbox(videoEl.videoWidth || INPUT_SIZE, videoEl.videoHeight || INPUT_SIZE)
    ctx.fillStyle = 'rgb(114,114,114)'                      // Ultralytics pad colour
    ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE)
    ctx.drawImage(videoEl, lb.padX, lb.padY, lb.w, lb.h)
    const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE)
    const input  = new ort.Tensor('float32', rgbaToTensor(data), [1, 3, INPUT_SIZE, INPUT_SIZE])
    const result = await sess.run({ [sess.inputNames[0]]: input })
    const output = result[sess.outputNames[0]]
    return { data: output.data, dims: output.dims, lb }
  }
}

/**
 * Start object monitoring. Returns stop() immediately; ONNX Runtime and the
 * model load in the background.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {object} callbacks
 * @param {function} [callbacks.onObjectDetected] ({ classId, className, confidence, bbox }) => void
 * @param {function} [callbacks.onPersons]        ({ count, confidence }) => void
 * @param {function} [callbacks.onReady]          () => void
 * @param {function} [callbacks.onError]          (err) => void
 * @param {object}   [options] OBJECT_DEFAULTS overrides, `modelUrl`, and
 *                   `createRunner(modelUrl) => Promise<run(videoEl)>` for tests
 * @returns {function} stop
 */
export function startObjectMonitor(videoEl, callbacks = {}, options = {}) {
  const { onObjectDetected, onPersons, onReady, onError, onTiming } = callbacks
  const cfg = { ...OBJECT_DEFAULTS, ...options }
  const modelUrl = options.modelUrl ?? import.meta.env?.VITE_YOLO_MODEL_URL ?? DEFAULT_MODEL_URL

  let stopped = false
  let busy    = false
  let intervalId

  ;(options.createRunner ?? defaultRunner)(modelUrl).then(run => {
    if (stopped) return
    onReady?.()

    async function scan() {
      if (stopped || busy || !videoEl || videoEl.readyState < 2) return
      busy = true
      try {
        const t0 = performance.now()
        const { data, dims, lb } = await run(videoEl)
        if (stopped) return
        const { objects, persons } = analyseOutput(data, dims, lb, cfg)
        onTiming?.(performance.now() - t0)   // preprocess + inference + decode (ms)
        for (const obj of objects) onObjectDetected?.(obj)
        onPersons?.({
          count: persons.length,
          confidence: persons.length ? Math.min(...persons.map(p => p.confidence)) : null,
        })
      } catch (err) {
        console.warn('[objectMonitor] inference error:', err.message)
      } finally {
        busy = false
      }
    }

    intervalId = setInterval(scan, cfg.scanIntervalMs)
    scan()
  }, err => { if (!stopped) onError?.(err) })

  return function stop() {
    stopped = true
    clearInterval(intervalId)
  }
}
