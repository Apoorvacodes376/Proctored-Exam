// @vitest-environment happy-dom
//
// The countdown must keep ticking and must call onExpire (automatic
// submission) exactly once, even when nothing else re-renders the exam room.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ExamTimer, { secondsLeft } from '../ExamTimer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container, root
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-03-01T09:00:00.300Z'))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const advance = ms => act(() => { vi.advanceTimersByTime(ms) })

describe('ExamTimer', () => {
  it('counts down without any other re-render', () => {
    const endsAt = Date.now() + 90_000
    act(() => root.render(<ExamTimer endsAt={endsAt} onExpire={() => {}} />))
    expect(container.textContent).toBe('01:30')
    advance(10_000)
    expect(container.textContent).toBe('01:20')
    advance(60_000)
    expect(container.textContent).toBe('00:20')
  })

  it('fires onExpire once when time runs out (automatic submission)', () => {
    const onExpire = vi.fn()
    act(() => root.render(<ExamTimer endsAt={Date.now() + 5_000} onExpire={onExpire} />))
    advance(4_000)
    expect(onExpire).not.toHaveBeenCalled()
    advance(1_500)
    expect(onExpire).toHaveBeenCalledTimes(1)
    advance(10_000)
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('00:00')
  })

  it('fires immediately when the deadline has already passed (e.g. after a reload)', () => {
    const onExpire = vi.fn()
    act(() => root.render(<ExamTimer endsAt={Date.now() - 60_000} onExpire={onExpire} />))
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('uses the latest onExpire callback (with the latest answers)', () => {
    const first = vi.fn(), second = vi.fn()
    const endsAt = Date.now() + 3_000
    act(() => root.render(<ExamTimer endsAt={endsAt} onExpire={first} />))
    act(() => root.render(<ExamTimer endsAt={endsAt} onExpire={second} />))
    advance(4_000)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('secondsLeft rounds up so time is never cut short', () => {
    expect(secondsLeft(10_500, 10_000)).toBe(1)
    expect(secondsLeft(10_000, 10_000)).toBe(0)
    expect(secondsLeft(5_000, 10_000)).toBe(0)
  })
})
