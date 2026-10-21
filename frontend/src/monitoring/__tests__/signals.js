// Synthesized test audio shared by the audio tests.

export const SR    = 48_000
export const FRAME = 2048          // AnalyserNode fftSize used in the browser
export const HOP   = SR / 10       // the browser samples a frame every 100 ms

// Deterministic PRNG so tests are reproducible.
export function rng(seed = 1) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

export const db = d => 10 ** (d / 20)

/** White noise at a given RMS level (dBFS). */
export function noise(seconds, levelDb, rand = rng(7)) {
  const out = new Float32Array(Math.round(seconds * SR))
  const amp = db(levelDb) * Math.sqrt(3)            // uniform[-1,1] has rms 1/√3
  for (let i = 0; i < out.length; i++) out[i] = (rand() * 2 - 1) * amp
  return out
}

export function tone(seconds, hz, levelDb) {
  const out = new Float32Array(Math.round(seconds * SR))
  const amp = db(levelDb) * Math.SQRT2
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin(2 * Math.PI * hz * i / SR)
  return out
}

/**
 * Speech-like signal: additive voiced harmonics (f0 ≈ 110–140 Hz with
 * vibrato) shaped by vowel formants, -6 dB/oct tilt, syllabic 4 Hz
 * amplitude envelope with short pauses, vowel changing every 250 ms.
 */
export function speech(seconds, levelDb, rand = rng(3)) {
  const vowels = [[730, 1090, 2440], [270, 2290, 3010], [530, 1840, 2480], [570, 840, 2410], [300, 870, 2240]]
  const n   = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const phases = new Float64Array(64)
  let vowel = vowels[0]
  for (let i = 0; i < n; i++) {
    const t = i / SR
    if (i % (SR / 4) === 0) vowel = vowels[Math.floor(rand() * vowels.length)]
    const f0  = 125 + 15 * Math.sin(2 * Math.PI * 0.7 * t) + 5 * Math.sin(2 * Math.PI * 5 * t)
    const syl = Math.max(0, Math.sin(2 * Math.PI * 4 * t))   // half-wave → pauses between syllables
    let s = 0
    for (let k = 1; k < 64 && k * f0 < 7000; k++) {
      phases[k] += 2 * Math.PI * k * f0 / SR
      const fk = k * f0
      let env = 0
      for (const F of vowel) env += 1 / (1 + ((fk - F) / 90) ** 2)
      s += (env / k ** 0.5) * Math.sin(phases[k])
    }
    out[i] = s * syl
  }
  return scaleTo(out, levelDb)
}

export function scaleTo(sig, levelDb) {
  let sq = 0
  for (const x of sig) sq += x * x
  const k = db(levelDb) / Math.sqrt(sq / sig.length)
  return sig.map(x => x * k)
}

export function mix(...sigs) {
  const n   = Math.max(...sigs.map(s => s.length))
  const out = new Float32Array(n)
  for (const s of sigs) for (let i = 0; i < s.length; i++) out[i] += s[i]
  return out
}

export function concat(...sigs) {
  const out = new Float32Array(sigs.reduce((s, x) => s + x.length, 0))
  let o = 0
  for (const s of sigs) { out.set(s, o); o += s.length }
  return out
}

