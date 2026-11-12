// Downloads the YOLOv8n model and a few openly licensed reference images
// used by src/monitoring/__tests__/objectMonitor.model.test.js.
// Files go to .cache/test-assets/ (git-ignored). Run: npm run test:assets

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_MODEL_URL } from '../src/monitoring/objectMonitor.js'

const dir = path.resolve(import.meta.dirname, '..', '.cache', 'test-assets')

export const ASSETS = {
  'yolov8n.onnx': DEFAULT_MODEL_URL,
  // CC0 — Wikimedia Commons "Smartphone Use"
  'phone-in-hand.jpg':   'https://upload.wikimedia.org/wikipedia/commons/thumb/5/57/Smartphone_Use.jpg/960px-Smartphone_Use.jpg',
  // CC0 — Wikimedia Commons "Smartphone use at railway station"
  'phones-station.jpg':  'https://upload.wikimedia.org/wikipedia/commons/thumb/5/55/Smartphone_use_at_railway_station.jpg/960px-Smartphone_use_at_railway_station.jpg',
  // CC BY 4.0 — COCO val2017 #1000 (group of people, no phone)
  'group.jpg':           'http://images.cocodataset.org/val2017/000000001000.jpg',
  // CC BY 4.0 — COCO val2017 #1761 (no people, no phone)
  'empty-scene.jpg':     'http://images.cocodataset.org/val2017/000000001761.jpg',
}

fs.mkdirSync(dir, { recursive: true })
for (const [name, url] of Object.entries(ASSETS)) {
  const dest = path.join(dir, name)
  if (fs.existsSync(dest)) { console.log('have', name); continue }
  const res = await fetch(url, { headers: { 'User-Agent': 'ProctorAI-tests/1.0' } })
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  console.log('got ', name)
}
