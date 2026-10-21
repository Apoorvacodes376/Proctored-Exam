// Node-side stand-in for the browser's canvas letterbox in objectMonitor.js:
// decode a JPEG and draw it, aspect-preserved and padded with grey 114,
// into a size×size RGBA buffer (bilinear sampling).

import fs from 'node:fs'
import jpeg from 'jpeg-js'
import { letterbox, INPUT_SIZE } from '../objectMonitor'

export function loadJpeg(path) {
  return jpeg.decode(fs.readFileSync(path), { useTArray: true })
}

export function letterboxRgba({ width, height, data }, size = INPUT_SIZE) {
  const lb  = letterbox(width, height, size)
  const out = new Uint8ClampedArray(size * size * 4).fill(114)
  for (let y = 0; y < lb.h; y++) {
    const sy = Math.min(height - 1, (y + 0.5) / lb.scale - 0.5)
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(height - 1, y0 + 1), fy = Math.max(0, sy - y0)
    for (let x = 0; x < lb.w; x++) {
      const sx = Math.min(width - 1, (x + 0.5) / lb.scale - 0.5)
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(width - 1, x0 + 1), fx = Math.max(0, sx - x0)
      const o = ((y + lb.padY) * size + (x + lb.padX)) * 4
      for (let c = 0; c < 3; c++) {
        const p = (yy, xx) => data[(yy * width + xx) * 4 + c]
        out[o + c] = (p(y0, x0) * (1 - fx) + p(y0, x1) * fx) * (1 - fy) + (p(y1, x0) * (1 - fx) + p(y1, x1) * fx) * fy
      }
      out[o + 3] = 255
    }
  }
  return { rgba: out, lb }
}
