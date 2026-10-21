import { describe, it, expect } from 'vitest'
import { createVoiceActivityDetector, frameFeatures, powerSpectrum } from '../vad'
import { SR, FRAME, HOP, rng, noise, tone, speech, mix, concat } from './signals'

/** Feed a signal through the detector the way the browser does. */
function run(signal, opts = {}) {
  const vad = createVoiceActivityDetector({ sampleRate: SR, ...opts })
  const events = []
  for (let end = FRAME, t = 0; end <= signal.length; end += HOP, t += 100) {
    for (const e of vad.process(signal.subarray(end - FRAME, end), t)) events.push(e)
  }
  return { events, vad, types: events.map(e => e.type) }
}

describe('powerSpectrum', () => {
  it('puts a pure tone in the right bin', () => {
    const spec = powerSpectrum(tone(FRAME / SR, 1000, -20).subarray(0, FRAME))
    let peak = 0
    for (let i = 1; i < spec.length; i++) if (spec[i] > spec[peak]) peak = i
    expect(peak * SR / FRAME).toBeCloseTo(1000, -2)
  })

  it('rejects non power-of-two frames', () => {
    expect(() => powerSpectrum(new Float32Array(1000))).toThrow()
  })
})

describe('frameFeatures', () => {
  it('separates voiced speech from white noise and pure tones', () => {
    const sp = speech(1, -20)
    // pick a frame at a syllable peak (sin(2π·4·t) = 1 at t = 62.5 ms)
    const peak = Math.round(0.0625 * SR)
    const fs = frameFeatures(sp.subarray(peak - FRAME / 2, peak + FRAME / 2), SR)
    const fn = frameFeatures(noise(0.1, -20).subarray(0, FRAME), SR)
    const ft = frameFeatures(tone(0.1, 1000, -20).subarray(0, FRAME), SR)

    expect(fs.flatness).toBeLessThan(0.35)
    expect(fs.speechRatio).toBeGreaterThan(0.12)
    expect(fs.peakShare).toBeLessThan(0.7)

    expect(fn.flatness).toBeGreaterThan(0.35)   // hiss is spectrally flat
    expect(ft.peakShare).toBeGreaterThan(0.7)   // a beep is one peak
    expect(fs.level).toBeGreaterThan(-20)        // syllable peak is louder than the average
  })
})

describe('createVoiceActivityDetector', () => {
  it('requires a sample rate', () => {
    expect(() => createVoiceActivityDetector({})).toThrow()
  })

  it('stays quiet on silence', () => {
    expect(run(noise(5, -75)).events).toEqual([])
  })

  it('absorbs steady background noise (fan / air-con) without events', () => {
    expect(run(noise(10, -40)).events).toEqual([])
  })

  it('detects sustained speech over background noise as one episode', () => {
    const sig = concat(
      noise(2, -50),
      mix(noise(4, -50, rng(9)), speech(4, -22)),
      noise(3, -50, rng(11)),
    )
    const { events, types } = run(sig)
    expect(types).toEqual(['speech_start', 'speech_end'])
    const start = events[0]
    expect(start.at).toBeGreaterThanOrEqual(2000)
    expect(start.at).toBeLessThanOrEqual(3500)
    expect(start.confidence).toBeGreaterThanOrEqual(0.5)
    expect(events[1].durationMs).toBeGreaterThan(2500)
  })

  it('does not call a steady beep speech', () => {
    const { types } = run(concat(noise(1, -55), mix(noise(5, -55, rng(2)), tone(5, 1000, -20))))
    expect(types).not.toContain('speech_start')
  })

  it('does not call mains hum speech', () => {
    let hum = new Float32Array(5 * SR)
    for (const h of [50, 100, 150, 200, 250]) hum = mix(hum, tone(5, h, -30 - h / 25))
    const { types } = run(concat(noise(1, -55), mix(noise(5, -55, rng(4)), hum)))
    expect(types).not.toContain('speech_start')
  })

  it('flags a loud bang as unusual noise, once', () => {
    const sig = concat(noise(2, -50), noise(0.3, -12, rng(5)), noise(3, -50, rng(6)))
    const { events, types } = run(sig)
    expect(types).toEqual(['noise_start', 'noise_end'])
    expect(events[0].aboveFloorDb).toBeGreaterThan(20)
  })

  it('reports a sustained loud noise once, then adapts to it', () => {
    const sig = concat(noise(2, -55), noise(30, -25, rng(8)))
    const { types, vad } = run(sig)
    expect(types).toEqual(['noise_start', 'noise_end'])
    expect(vad.noiseFloorDb).toBeGreaterThan(-35)
  })

  it('still detects speech after the floor has adapted to a fan', () => {
    const sig = concat(noise(8, -40), mix(noise(5, -40, rng(12)), speech(5, -18)))
    const { types } = run(sig)
    expect(types[0]).toBe('speech_start')
  })
})
