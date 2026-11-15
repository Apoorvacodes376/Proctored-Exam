import { describe, it, expect } from 'vitest'
import {
  STEPS, LIVENESS_CONFIG, eyeAspectRatio, estimateYaw, createChallenge,
  createLivenessSession, worstDistance,
} from '../liveness'

/** Synthetic 68 points: eye openness `open` (0..1) and yaw offset. */
function face({ open = 1, yaw = 0 } = {}) {
  const p = Array.from({ length: 68 }, () => ({ x: 0, y: 0 }))
  p[0] = { x: 0, y: 50 }; p[16] = { x: 100, y: 50 }
  p[30] = { x: 50 + yaw * 100, y: 60 }
  const eye = (x0) => {
    const h = 0.3 * open
    return [
      { x: x0, y: 0 }, { x: x0 + 10, y: -h * 20 }, { x: x0 + 20, y: -h * 20 },
      { x: x0 + 30, y: 0 }, { x: x0 + 20, y: h * 20 }, { x: x0 + 10, y: h * 20 },
    ]
  }
  eye(20).forEach((q, i) => { p[36 + i] = q })
  eye(60).forEach((q, i) => { p[42 + i] = q })
  return p
}
const sample = (opts) => { const f = face(opts); return { ear: eyeAspectRatio(f), yaw: estimateYaw(f) } }

describe('geometry', () => {
  it('EAR is high for open eyes and low for closed', () => {
    expect(eyeAspectRatio(face({ open: 1 }))).toBeGreaterThan(LIVENESS_CONFIG.earOpen)
    expect(eyeAspectRatio(face({ open: 0.1 }))).toBeLessThan(LIVENESS_CONFIG.earClosed)
  })
  it('yaw is ~0 facing the camera, positive to the student\'s left', () => {
    expect(Math.abs(estimateYaw(face()))).toBeLessThan(0.01)
    expect(estimateYaw(face({ yaw: 0.2 }))).toBeGreaterThan(0)
    expect(estimateYaw(face({ yaw: -0.2 }))).toBeLessThan(0)
  })
  it('rejects too few points', () => {
    expect(() => eyeAspectRatio([])).toThrow()
    expect(() => estimateYaw([])).toThrow()
  })
})

describe('createChallenge', () => {
  it('has the requested length and never repeats a step back to back', () => {
    for (let i = 0; i < 200; i++) {
      const c = createChallenge(Math.random, 4)
      expect(c).toHaveLength(4)
      for (let j = 1; j < c.length; j++) expect(c[j]).not.toBe(c[j - 1])
    }
  })
  it('is driven by the injected RNG and varies', () => {
    expect(createChallenge(() => 0, 2)).toEqual([STEPS.BLINK, STEPS.TURN_LEFT])
    const seen = new Set()
    for (let i = 0; i < 100; i++) seen.add(createChallenge().join())
    expect(seen.size).toBeGreaterThan(3)
  })
})

describe('createLivenessSession', () => {
  it('passes a blink: open, closed, open', () => {
    const s = createLivenessSession([STEPS.BLINK])
    expect(s.update(sample({ open: 1 }), 0).status).toBe('pending')
    expect(s.update(sample({ open: 0.05 }), 150).status).toBe('pending')
    expect(s.update(sample({ open: 1 }), 300).status).toBe('passed')
  })
  it('does not pass a blink if the eyes never close', () => {
    const s = createLivenessSession([STEPS.BLINK])
    for (let t = 0; t < 7000; t += 150) expect(s.update(sample({ open: 1 }), t).status).toBe('pending')
    expect(s.update(sample({ open: 1 }), 9000).status).toBe('failed')
  })
  it('does not pass a blink for eyes that start closed and stay closed', () => {
    const s = createLivenessSession([STEPS.BLINK])
    for (let t = 0; t < 7000; t += 150) s.update(sample({ open: 0.05 }), t)
    expect(s.update(sample({ open: 0.05 }), 9000).status).toBe('failed')
  })
  it('passes a left turn only in the right direction and when held', () => {
    const s = createLivenessSession([STEPS.TURN_LEFT])
    expect(s.update(sample({ yaw: -0.25 }), 0).status).toBe('pending') // wrong way
    expect(s.update(sample({ yaw: 0.25 }), 150).status).toBe('pending') // 1 sample
    expect(s.update(sample({ yaw: 0 }), 300).status).toBe('pending')    // not held
    s.update(sample({ yaw: 0.25 }), 450)
    expect(s.update(sample({ yaw: 0.25 }), 600).status).toBe('passed')
  })
  it('passes a right turn', () => {
    const s = createLivenessSession([STEPS.TURN_RIGHT])
    s.update(sample({ yaw: -0.25 }), 0)
    expect(s.update(sample({ yaw: -0.25 }), 150).status).toBe('passed')
  })
  it('walks through a multi-step challenge and reports the prompt', () => {
    const s = createLivenessSession([STEPS.TURN_LEFT, STEPS.BLINK])
    expect(s.update(sample({ yaw: 0.25 }), 0).prompt).toMatch(/left/i)
    const r = s.update(sample({ yaw: 0.25 }), 150)
    expect(r.status).toBe('pending')
    expect(r.step).toBe(STEPS.BLINK)
    s.update(sample({ open: 1 }), 300)
    s.update(sample({ open: 0.05 }), 450)
    expect(s.update(sample({ open: 1 }), 600).status).toBe('passed')
  })
  it('fails on timeout, including when no face is seen, and stays failed', () => {
    const s = createLivenessSession([STEPS.BLINK])
    s.update(null, 0)
    const r = s.update(null, LIVENESS_CONFIG.stepTimeoutMs + 1)
    expect(r.status).toBe('failed')
    expect(r.failedStep).toBe(STEPS.BLINK)
    expect(s.update(sample({ open: 1 }), 20000).status).toBe('failed')
  })
  it('a static photo (no motion) never passes any challenge', () => {
    for (const step of Object.values(STEPS)) {
      const s = createLivenessSession([step])
      let last
      for (let t = 0; t <= 9000; t += 150) last = s.update(sample({ open: 1, yaw: 0 }), t)
      expect(last.status).toBe('failed')
    }
  })
})

describe('worstDistance', () => {
  it('uses the larger distance', () => {
    expect(worstDistance(0.3, 0.8)).toBe(0.8)
    expect(worstDistance(0.9, 0.2)).toBe(0.9)
  })
})
