/**
 * vad.js
 * Pure voice-activity / noise classifier used by audioMonitor.js.
 *
 * Works on raw time-domain frames (Float32Array, -1..1) so it can be fed
 * from an AnalyserNode in the browser or from synthesized audio in tests.
 *
 * Per frame it computes, from a Hann-windowed FFT:
 *   - level        : RMS in dBFS
 *   - speechRatio  : energy in 300–3400 Hz / energy in 80–8000 Hz
 *                    (voices always carry formant energy here; mains hum
 *                    and rumble do not)
 *   - flatness     : spectral flatness in the speech band (harmonic
 *                    voiced speech ≈ low, hiss/fan/static ≈ high)
 *   - peakShare    : share of speech-band energy held by its strongest
 *                    bins (a pure tone / beep ≈ 1)
 * and tracks an adaptive noise floor so steady background noise (fans,
 * air-con, hum) is absorbed rather than reported.
 *
 * This follows the same idea as WebRTC's VAD (sub-band features + an
 * adaptive noise model + hangover) but it is NOT the WebRTC GMM itself.
 * Limitations, stated honestly:
 *   - It cannot tell whose voice it hears, or what is said.
 *   - Speech from a TV, video or music with vocals looks like speech.
 *   - Whispering may fall below the activity threshold.
 *
 * No browser APIs — fully testable in Node.
 */

export const VAD_DEFAULTS = {
  minLevelDb:                -60,   // anything quieter is silence
  activeAboveFloorDb:          8,   // frame is "active" this far above the floor
  speechBand:         [300, 3400],
  analysisBand:        [80, 8000],
  minSpeechBandRatio:       0.12,
  maxSpeechFlatness:        0.35,
  maxPeakShare:             0.7,
  windowFrames:               20,   // sliding window (2 s at 100 ms/frame)
  speechOnFraction:          0.4,   // voiced share of window that starts speech
  speechOffFraction:         0.1,   // voiced share at/below which speech ends
  minSpeechModulationDb:       3,   // syllabic level variation; rejects steady sounds
  unusualNoiseAboveFloorDb:   20,
  unusualNoiseMinDb:         -35,
  noiseConfirmFrames:          3,   // loud+unvoiced frames must agree over this many
  noiseEndQuietFrames:        10,   // quiet frames that close a noise episode
  floorRiseDbPerFrame:       0.1,   // slow upward adaptation of the floor
}

// ── FFT ─────────────────────────────────────────────────────────

const fftCache = new Map()

function fftTables(n) {
  let t = fftCache.get(n)
  if (t) return t
  const rev = new Uint32Array(n)
  const bits = Math.log2(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    rev[i] = r
  }
  const cos = new Float64Array(n / 2)
  const sin = new Float64Array(n / 2)
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos(-2 * Math.PI * i / n)
    sin[i] = Math.sin(-2 * Math.PI * i / n)
  }
  const hann = new Float64Array(n)
  for (let i = 0; i < n; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)))
  t = { rev, cos, sin, hann }
  fftCache.set(n, t)
  return t
}

/**
 * Hann-windowed power spectrum of a frame whose length is a power of two.
 * Returns Float64Array of length n/2 + 1.
 */
export function powerSpectrum(frame) {
  const n = frame.length
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error('frame length must be a power of two')
  const { rev, cos, sin, hann } = fftTables(n)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[rev[i]] = frame[i] * hann[i]

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    const step = n / size
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step]
        const a = start + k, b = a + half
        const tr = re[b] * wr - im[b] * wi
        const ti = re[b] * wi + im[b] * wr
        re[b] = re[a] - tr; im[b] = im[a] - ti
        re[a] += tr;        im[a] += ti
      }
    }
  }
  const out = new Float64Array(n / 2 + 1)
  for (let i = 0; i <= n / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i]
  return out
}

// ── Frame features ──────────────────────────────────────────────

export function frameFeatures(frame, sampleRate, cfg = VAD_DEFAULTS) {
  let sq = 0
  for (let i = 0; i < frame.length; i++) sq += frame[i] * frame[i]
  const rms   = Math.sqrt(sq / frame.length)
  const level = 20 * Math.log10(rms + 1e-12)

  const spec  = powerSpectrum(frame)
  const binHz = sampleRate / frame.length
  const bin   = hz => Math.min(spec.length - 1, Math.max(0, Math.round(hz / binHz)))

  const [aLo, aHi] = cfg.analysisBand.map(bin)
  const [sLo, sHi] = cfg.speechBand.map(bin)

  let total = 0
  for (let i = aLo; i <= aHi; i++) total += spec[i]

  let band = 0, logSum = 0
  const bandBins = []
  for (let i = sLo; i <= sHi; i++) {
    band   += spec[i]
    logSum += Math.log(spec[i] + 1e-20)
    bandBins.push(spec[i])
  }
  const count    = sHi - sLo + 1
  const flatness = band > 0 ? Math.exp(logSum / count) / (band / count) : 1

  // Share of band energy held by the strongest ~60 Hz worth of bins
  // (one harmonic's main lobe). A pure tone puts nearly everything there.
  bandBins.sort((x, y) => y - x)
  const topN = Math.max(3, Math.round(60 / binHz))
  let top = 0
  for (let i = 0; i < topN && i < bandBins.length; i++) top += bandBins[i]

  return {
    level,
    speechRatio: total > 0 ? band / total : 0,
    flatness,
    peakShare:   band > 0 ? top / band : 0,
  }
}

// ── Detector ────────────────────────────────────────────────────

/**
 * Stateful detector. Call process(frame, now) once per frame (~100 ms).
 * Returns an array of events, each one of:
 *   { type: 'speech_start', confidence, at }
 *   { type: 'speech_end',   durationMs, at }
 *   { type: 'noise_start',  peakDb, aboveFloorDb, at }
 *   { type: 'noise_end',    durationMs, at }
 * Events are edge-triggered: one start/end pair per continuous episode.
 */
export function createVoiceActivityDetector({ sampleRate, ...overrides }) {
  if (!sampleRate) throw new Error('sampleRate is required')
  const cfg = { ...VAD_DEFAULTS, ...overrides }

  let floor        = null
  const window     = []          // [{ voiced, level, active, loud }]
  let speechSince  = null
  let noiseSince   = null
  let quietFrames  = 0

  function process(frame, now = Date.now()) {
    const f = frameFeatures(frame, sampleRate, cfg)
    const events = []

    if (floor === null) floor = f.level
    const aboveFloor = f.level - floor
    const active = f.level > cfg.minLevelDb && aboveFloor >= cfg.activeAboveFloorDb
    const voiced = active &&
      f.speechRatio >= cfg.minSpeechBandRatio &&
      f.flatness    <= cfg.maxSpeechFlatness &&
      f.peakShare   <= cfg.maxPeakShare

    const loud = !voiced &&
      aboveFloor >= cfg.unusualNoiseAboveFloorDb &&
      f.level    >= cfg.unusualNoiseMinDb

    window.push({ voiced, active, loud, level: f.level })
    if (window.length > cfg.windowFrames) window.shift()

    const voicedShare = window.filter(w => w.voiced).length / cfg.windowFrames

    // Syllabic modulation: speech rises and falls (and pauses) several dB
    // within a couple of seconds; steady tones and hum do not.
    const levels = window.map(w => Math.max(w.level, floor))
    const mean   = levels.reduce((s, x) => s + x, 0) / levels.length
    const modulation = Math.sqrt(levels.reduce((s, x) => s + (x - mean) ** 2, 0) / levels.length)

    // ── Speech episodes ──
    if (speechSince === null) {
      if (voicedShare >= cfg.speechOnFraction && modulation >= cfg.minSpeechModulationDb) {
        speechSince = now
        // confidence: voiced share of the window, scaled so the on-threshold ≈ 0.5
        events.push({ type: 'speech_start', confidence: Math.min(1, voicedShare / (2 * cfg.speechOnFraction)), at: now })
      }
    } else if (voicedShare <= cfg.speechOffFraction) {
      events.push({ type: 'speech_end', durationMs: now - speechSince, at: now })
      speechSince = null
    }

    // ── Unusual (loud, non-speech) noise episodes ──
    // Require agreement over a few frames so the first, not-yet-voiced
    // frames of someone starting to talk aren't reported as a bang.
    const recent = window.slice(-cfg.noiseConfirmFrames)
    const confirmedLoud = recent.length === cfg.noiseConfirmFrames &&
      recent.filter(w => w.loud).length >= cfg.noiseConfirmFrames - 1 &&
      !recent.some(w => w.voiced)
    if (noiseSince === null) {
      if (confirmedLoud && speechSince === null) {
        const peak = Math.max(...recent.map(w => w.level))
        noiseSince  = now
        quietFrames = 0
        events.push({ type: 'noise_start', peakDb: round1(peak), aboveFloorDb: round1(peak - floor), at: now })
      }
    } else {
      quietFrames = active ? 0 : quietFrames + 1
      if (quietFrames >= cfg.noiseEndQuietFrames) {
        events.push({ type: 'noise_end', durationMs: now - noiseSince, at: now })
        noiseSince = null
      }
    }

    // ── Adaptive floor ── fall immediately, rise slowly, and hold while
    // speech is ongoing so a long talker isn't absorbed into "background".
    if (f.level < floor) floor = f.level
    else if (speechSince === null) floor = Math.min(f.level, floor + cfg.floorRiseDbPerFrame)

    return events
  }

  return {
    process,
    get noiseFloorDb() { return floor },
    get speaking()     { return speechSince !== null },
  }
}

function round1(x) { return Math.round(x * 10) / 10 }
