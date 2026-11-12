import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startStreamMonitor } from '../streamMonitor'

class FakeTrack extends EventTarget {
  constructor(kind) { super(); this.kind = kind; this.readyState = 'live'; this.muted = false }
  end()    { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')) }
  mute()   { this.muted = true;  this.dispatchEvent(new Event('mute')) }
  unmute() { this.muted = false; this.dispatchEvent(new Event('unmute')) }
}

function fakeStream({ video = true, audio = true } = {}) {
  const v = video ? new FakeTrack('video') : null
  const a = audio ? new FakeTrack('audio') : null
  return { v, a, stream: { getVideoTracks: () => (v ? [v] : []), getAudioTracks: () => (a ? [a] : []) } }
}

class FakePermissionStatus extends EventTarget {
  constructor() { super(); this.state = 'granted' }
  set(state) { this.state = state; this.dispatchEvent(new Event('change')) }
}

function fakePermissions() {
  const statuses = { camera: new FakePermissionStatus(), microphone: new FakePermissionStatus() }
  return { statuses, query: async ({ name }) => statuses[name] }
}

describe('startStreamMonitor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('stays silent while both tracks are healthy', async () => {
    const { stream } = fakeStream()
    const cb = { onLost: vi.fn(), onRestored: vi.fn() }
    const stop = startStreamMonitor(stream, cb, { permissions: null })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(cb.onLost).not.toHaveBeenCalled()
    stop()
  })

  it('reports a missing microphone immediately, once', async () => {
    const { stream } = fakeStream({ audio: false })
    const onLost = vi.fn()
    const stop = startStreamMonitor(stream, { onLost }, { permissions: null })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onLost).toHaveBeenCalledOnce()
    expect(onLost).toHaveBeenCalledWith('microphone', 'missing')
    stop()
  })

  it('reports an ended camera once across many polls (no duplicate alerts)', async () => {
    const { v, stream } = fakeStream()
    const onLost = vi.fn()
    const stop = startStreamMonitor(stream, { onLost }, { permissions: null })
    v.end()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onLost).toHaveBeenCalledOnce()
    expect(onLost).toHaveBeenCalledWith('camera', 'ended')
    stop()
  })

  it('detects mute without an event (poll fallback) and reports restore with downtime', async () => {
    const { a, stream } = fakeStream()
    const cb = { onLost: vi.fn(), onRestored: vi.fn() }
    const stop = startStreamMonitor(stream, cb, { permissions: null })
    a.muted = true                                // no event fired
    await vi.advanceTimersByTimeAsync(2_000)
    expect(cb.onLost).toHaveBeenCalledWith('microphone', 'muted')
    await vi.advanceTimersByTimeAsync(5_000)
    a.unmute()
    expect(cb.onRestored).toHaveBeenCalledWith('microphone', 5_000)   // detected at 2 s, restored at 7 s
    expect(cb.onLost).toHaveBeenCalledOnce()
    stop()
  })

  it('treats each separate interruption as its own episode', async () => {
    const { v, stream } = fakeStream()
    const cb = { onLost: vi.fn(), onRestored: vi.fn() }
    const stop = startStreamMonitor(stream, cb, { permissions: null })
    v.mute(); v.mute(); v.unmute(); v.mute(); v.unmute()
    expect(cb.onLost).toHaveBeenCalledTimes(2)
    expect(cb.onRestored).toHaveBeenCalledTimes(2)
    stop()
  })

  it('reports permission revocation from the Permissions API', async () => {
    const { stream } = fakeStream()
    const perms = fakePermissions()
    const cb = { onLost: vi.fn(), onRestored: vi.fn() }
    const stop = startStreamMonitor(stream, cb, { permissions: perms })
    await vi.advanceTimersByTimeAsync(0)
    perms.statuses.camera.set('denied')
    expect(cb.onLost).toHaveBeenCalledWith('camera', 'permission_revoked')
    perms.statuses.camera.set('granted')
    expect(cb.onRestored).toHaveBeenCalledWith('camera', expect.any(Number))
    stop()
  })

  it('tolerates browsers whose Permissions API rejects camera queries', async () => {
    const { stream } = fakeStream()
    const onLost = vi.fn()
    const stop = startStreamMonitor(stream, { onLost }, { permissions: { query: () => Promise.reject(new TypeError('x')) } })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onLost).not.toHaveBeenCalled()
    stop()
  })

  it('stops listening after stop()', async () => {
    const { v, stream } = fakeStream()
    const onLost = vi.fn()
    const stop = startStreamMonitor(stream, { onLost }, { permissions: null })
    stop()
    v.end()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onLost).not.toHaveBeenCalled()
  })
})
