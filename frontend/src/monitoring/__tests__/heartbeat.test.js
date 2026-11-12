import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHeartbeat, liveFields } from '../heartbeat'

const base = { camera: 'ok', microphone: 'ok', face: 'present', objects: 'active', audio: 'running', away: false, logging: 'ok', alerts: [{ id: 'x' }] }

describe('createHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('only reports the live fields (no local alert state)', () => {
    expect(liveFields(base)).not.toHaveProperty('alerts')
    expect(liveFields({ ...base, away: undefined }).away).toBe(false)
  })

  it('sends the first status straight away and then every interval', async () => {
    const send = vi.fn(async () => {})
    const hb = createHeartbeat({ send, intervalMs: 10_000 })
    hb.update(base)
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(send).toHaveBeenCalledTimes(4)         // keep-alives even without changes
    hb.stop()
  })

  it('does not resend unchanged status between keep-alives', async () => {
    const send = vi.fn(async () => {})
    const hb = createHeartbeat({ send, intervalMs: 10_000 })
    hb.update(base); await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) hb.update({ ...base, alerts: [] })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(send).toHaveBeenCalledTimes(1)
    hb.stop()
  })

  it('throttles bursts of changes and sends the latest one', async () => {
    const send = vi.fn(async () => {})
    const hb = createHeartbeat({ send, intervalMs: 60_000, minGapMs: 2_000 })
    hb.update(base); await vi.advanceTimersByTimeAsync(0)
    hb.update({ ...base, face: 'absent' })
    hb.update({ ...base, face: 'absent', away: true })
    await vi.advanceTimersByTimeAsync(1_999)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0]).toMatchObject({ face: 'absent', away: true })
    hb.stop()
  })

  it('keeps going after a failed send and reports the error', async () => {
    const onError = vi.fn()
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue()
    const hb = createHeartbeat({ send, intervalMs: 10_000, onError })
    hb.update(base); await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(send).toHaveBeenCalledTimes(2)
    hb.stop()
  })

  it('stops sending after stop()', async () => {
    const send = vi.fn(async () => {})
    const hb = createHeartbeat({ send })
    hb.stop()
    hb.update(base)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).not.toHaveBeenCalled()
  })
})
