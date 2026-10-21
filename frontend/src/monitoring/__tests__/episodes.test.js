import { describe, it, expect, vi } from 'vitest'
import { createEpisodes, createHitWindow } from '../episodes'

const flush = () => new Promise(r => setTimeout(r, 0))

function fakeLogger() {
  let n = 0
  return {
    log:   vi.fn(async e => ({ id: `evt-${++n}`, ...e })),
    close: vi.fn(async () => {}),
  }
}

describe('createEpisodes', () => {
  it('logs once per open episode and closes it with the event id', async () => {
    const logger = fakeLogger()
    const ep = createEpisodes(logger)
    expect(ep.open('camera', { eventType: 'camera_interrupted' })).toBe(true)
    expect(ep.open('camera', { eventType: 'camera_interrupted' })).toBe(false)   // still the same interruption
    expect(ep.isOpen('camera')).toBe(true)
    ep.close('camera', 123)
    await flush()
    expect(logger.log).toHaveBeenCalledOnce()
    expect(logger.close).toHaveBeenCalledWith('evt-1', 123)
    expect(ep.isOpen('camera')).toBe(false)
  })

  it('closes correctly even if close() is called before the log resolves', async () => {
    let resolve
    const logger = { log: vi.fn(() => new Promise(r => { resolve = r })), close: vi.fn() }
    const ep = createEpisodes(logger)
    ep.open('tab', { eventType: 'tab_switch' })
    ep.close('tab', 50)
    await flush()
    expect(logger.close).not.toHaveBeenCalled()
    resolve({ id: 'late' })
    await flush()
    expect(logger.close).toHaveBeenCalledWith('late', 50)
  })

  it('does not close an event that was suppressed by the cooldown', async () => {
    const logger = { log: vi.fn(async () => null), close: vi.fn() }
    const ep = createEpisodes(logger)
    ep.open('face', { eventType: 'face_not_detected' })
    ep.close('face')
    await flush()
    expect(logger.close).not.toHaveBeenCalled()
  })

  it('reports logging errors instead of throwing', async () => {
    const onError = vi.fn()
    const ep = createEpisodes({ log: async () => { throw new Error('rls') }, close: vi.fn() }, { onError })
    ep.open('x', {})
    ep.close('x')
    await flush()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'rls' }))
  })

  it('closeAll closes every open episode', async () => {
    const logger = fakeLogger()
    const ep = createEpisodes(logger)
    ep.open('a', {}); ep.open('b', {})
    ep.closeAll(9)
    await flush()
    expect(logger.close).toHaveBeenCalledTimes(2)
  })
})

describe('createHitWindow', () => {
  it('starts after 2 of 3 hits and ends after 3 misses', () => {
    const w = createHitWindow(3, 2)
    const seq = [true, false, false, true, true, true, false, false, false].map(h => w.update(h))
    expect(seq).toEqual([null, null, null, null, 'start', null, null, null, 'end'])
  })
})
