/**
 * objectMonitor.js
 * Module 3: Object Detection (phone / prohibited items)
 *
 * Uses YOLOv8n (ONNX) via ONNX Runtime Web loaded from CDN.
 * The model is ~6 MB and is fetched once then cached in memory.
 *
 * COCO class IDs we flag as prohibited:
 *   67 — cell phone
 *   73 — book  (notes)
 *   84 — book (alternate label in some COCO variants)
 *
 * Browser limitation note: ONNX Runtime Web runs in the main thread
 * via WebAssembly. Performance varies by device. On low-end hardware
 * the scan interval is automatically stretched to avoid blocking.
 *
 * Fully independent — no React, no Supabase.
 */

const ONNX_CDN      = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js'
const MODEL_URL     = 'https://huggingface.co/Xenova/yolov8n/resolve/main/onnx/model.onnx'
const INPUT_SIZE    = 640          // YOLOv8 default input
const CONF_THRESH   = 0.45
const SCAN_INTERVAL = 5_000        // ms between scans (heavier than face scan)

// COCO class indices to flag (0-indexed).
const FLAGGED_CLASSES = new Set([67])  // 67 = cell phone
const CLASS_NAMES = { 67: 'cell phone' }

let ort        = null   // onnxruntime-web namespace
let session    = null   // InferenceSession
let loadingOrt = false
let loadError  = null

async function loadOrt() {
  if (ort) return ort
  if (loadError) throw loadError
  if (loadingOrt) {
    // Wait for the in-flight load.
    await new Promise(res => setTimeout(res, 200))
    return loadOrt()
  }
  loadingOrt = true
  try {
    await new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${ONNX_CDN}"]`)) { resolve(); return }
      const s = document.createElement('script')
      s.src = ONNX_CDN
      s.onload  = resolve
      s.onerror = () => reject(new Error('Failed to load ONNX Runtime Web'))
      document.head.appendChild(s)
    })
    ort = window.ort
    if (!ort) throw new Error('ort not found on window after script load')
    return ort
  } catch (err) {
    loadError = err
    throw err
  } finally {
    loadingOrt = false
  }
}

async function ensureSession() {
  if (session) return session
  const _ort = await loadOrt()
  _ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/'
  session = await _ort.InferenceSession.create(MODEL_URL, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })
  return session
}

/**
 * Preprocess a video frame into a Float32 tensor [1, 3, 640, 640].
 */
function preprocess(videoEl) {
  const canvas = document.createElement('canvas')
  canvas.width  = INPUT_SIZE
  canvas.height = INPUT_SIZE
  const ctx = canvas.getContext('2d')
  ctx.drawImage(videoEl, 0, 0, INPUT_SIZE, INPUT_SIZE)
  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE)

  const float32 = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE)
  for (let i = 0; i < INPUT_SIZE * INPUT_SIZE; i++) {
    float32[i]                              = data[i * 4]     / 255  // R
    float32[INPUT_SIZE * INPUT_SIZE + i]    = data[i * 4 + 1] / 255  // G
    float32[2 * INPUT_SIZE * INPUT_SIZE + i]= data[i * 4 + 2] / 255  // B
  }
  return float32
}

/**
 * Parse YOLOv8 output tensor [1, 84, 8400] → detections.
 * Returns array of { classId, className, confidence, bbox }.
 */
function parseOutput(outputData, numClasses = 80) {
  const numBoxes = 8400
  const results  = []

  for (let b = 0; b < numBoxes; b++) {
    // cx, cy, w, h
    const cx = outputData[0 * numBoxes + b]
    const cy = outputData[1 * numBoxes + b]
    const w  = outputData[2 * numBoxes + b]
    const h  = outputData[3 * numBoxes + b]

    let maxConf = 0
    let classId = -1
    for (let c = 0; c < numClasses; c++) {
      const conf = outputData[(4 + c) * numBoxes + b]
      if (conf > maxConf) { maxConf = conf; classId = c }
    }

    if (maxConf < CONF_THRESH) continue
    if (!FLAGGED_CLASSES.has(classId)) continue

    results.push({
      classId,
      className:  CLASS_NAMES[classId] ?? `class_${classId}`,
      confidence: maxConf,
      bbox: { cx, cy, w, h },
    })
  }
  return results
}

/**
 * Start object monitoring on a video element.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {object} callbacks
 * @param {function} callbacks.onObjectDetected ({ className, confidence }) => void
 * @param {function} callbacks.onModelReady     () => void
 * @param {function} callbacks.onModelError     (err: Error) => void
 * @returns {function} stop
 */
export async function startObjectMonitor(videoEl, { onObjectDetected, onModelReady, onModelError }) {
  let stopped = false

  // Load model in background — don't block exam start.
  let sess
  try {
    sess = await ensureSession()
    onModelReady?.()
  } catch (err) {
    onModelError?.(err)
    // Return a no-op stop function; monitoring simply won't run.
    return () => {}
  }

  const _ort = await loadOrt()

  async function scan() {
    if (stopped || !videoEl || videoEl.readyState < 2) return

    try {
      const float32 = preprocess(videoEl)
      const tensor  = new _ort.Tensor('float32', float32, [1, 3, INPUT_SIZE, INPUT_SIZE])
      const feeds    = { images: tensor }
      const results  = await sess.run(feeds)

      // YOLOv8 output key is typically 'output0'
      const outputKey  = Object.keys(results)[0]
      const outputData = results[outputKey].data

      const detections = parseOutput(outputData)
      for (const det of detections) {
        onObjectDetected?.(det)
      }
    } catch (err) {
      // Transient inference errors are non-fatal.
      console.warn('[objectMonitor] inference error:', err.message)
    }
  }

  const intervalId = setInterval(scan, SCAN_INTERVAL)

  return function stop() {
    stopped = true
    clearInterval(intervalId)
  }
}
