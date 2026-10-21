import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startAudioMonitor } from '../audioMonitor'
import { SR, FRAME, noise, speech, concat, mix, rng } from './signals'

/**
 * Fake Web Audio graph: the analyser returns the 2048 samples of `signal`
 * ending at the current (fake) time, like a real AnalyserNode would.
 */
function fakeAudioContext(signal, { state = 'running' } = {}) {
  const t0 = Date.now()
  return class FakeCtx {
    constructor() {
      this.sampleRate = SR
      this.state = state
      this.closed = false
      FakeCtx.instance = this
    }
    createAnalyser() {
      return {
        fftSize: 0,
        getFloatTimeDomainData(buf) {
          const end = Math.min(signal.length, Math.max(FRAME, Math.round((Date.now() - t0) / 1000 * SR)))
          buf.set(signal.subarray(end - FRAME, end))
        },
      }
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    resume() { this.state = 'running'; return Promise.resolve() }
    close()  { this.closed = true; return Promise.resolve() }
  }
}

const streamWithAudio = { getAudioTracks: () => [{ kind: 'audio' }] }

describe('startAudioMonitor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reports unavailable when the stream has no audio track', () => {
    const onStateChange = vi.fn()
    const stop = startAudioMonitor({ getAudioTracks: () => [] }, { onStateChange })
    expect(onStateChange).toHaveBeenCalledWith('unavailable', 'no audio track')
    stop()
  })

  it('reports unavailable when Web Audio is missing', () => {
    const onStateChange = vi.fn()
    startAudioMonitor(streamWithAudio, { onStateChange }, { AudioContext: null })
    // falls back to globalThis.AudioContext, which Node does not have
    expect(onStateChange).toHaveBeenCalledWith('unavailable', 'Web Audio not supported')
  })

  it('emits one speech episode for someone talking in the room', () => {
    const sig = concat(noise(2, -50), mix(noise(4, -50, rng(9)), speech(4, -22)), noise(3, -50, rng(2)))
    const cb = { onSpeechStart: vi.fn(), onSpeechEnd: vi.fn(), onNoiseStart: vi.fn(), onStateChange: vi.fn() }
    const stop = startAudioMonitor(streamWithAudio, cb, { AudioContext: fakeAudioContext(sig) })

    vi.advanceTimersByTime(9_000)
    expect(cb.onStateChange).toHaveBeenCalledWith('running')
    expect(cb.onSpeechStart).toHaveBeenCalledTimes(1)
    expect(cb.onSpeechStart.mock.calls[0][0].confidence).toBeGreaterThan(0)
    expect(cb.onSpeechEnd).toHaveBeenCalledTimes(1)
    expect(cb.onNoiseStart).not.toHaveBeenCalled()
    stop()
  })

  it('emits unusual noise for a loud bang, not speech', () => {
    const sig = concat(noise(2, -50), noise(0.3, -12, rng(5)), noise(3, -50, rng(6)))
    const cb = { onSpeechStart: vi.fn(), onNoiseStart: vi.fn(), onNoiseEnd: vi.fn() }
    const stop = startAudioMonitor(streamWithAudio, cb, { AudioContext: fakeAudioContext(sig) })
    vi.advanceTimersByTime(5_000)
    expect(cb.onNoiseStart).toHaveBeenCalledTimes(1)
    expect(cb.onNoiseEnd).toHaveBeenCalledTimes(1)
    expect(cb.onSpeechStart).not.toHaveBeenCalled()
    stop()
  })

  it('reports a suspended context and does not analyse until resumed', async () => {
    const Ctx = fakeAudioContext(noise(3, -50), { state: 'suspended' })
    Ctx.prototype.resume = function () { return Promise.reject(new Error('needs gesture')) }
    const onStateChange = vi.fn()
    const stop = startAudioMonitor(streamWithAudio, { onStateChange }, { AudioContext: Ctx })
    expect(onStateChange).toHaveBeenCalledWith('suspended')
    Ctx.instance.state = 'running'
    vi.advanceTimersByTime(200)
    expect(onStateChange).toHaveBeenLastCalledWith('running')
    stop()
  })

  it('closes the AudioContext on stop', () => {
    const Ctx = fakeAudioContext(noise(1, -50))
    const stop = startAudioMonitor(streamWithAudio, {}, { AudioContext: Ctx })
    stop()
    expect(Ctx.instance.closed).toBe(true)
  })
})
