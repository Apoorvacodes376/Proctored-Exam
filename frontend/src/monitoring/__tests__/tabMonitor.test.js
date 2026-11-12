import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startTabMonitor } from '../tabMonitor'

function fakeBrowser() {
  const doc = new EventTarget()
  doc.hidden = false
  doc.hasFocus = () => true
  const win = new EventTarget()
  return {
    doc, win,
    hide()  { doc.hidden = true;  doc.dispatchEvent(new Event('visibilitychange')) },
    show()  { doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange')) },
    blur()  { win.dispatchEvent(new Event('blur')) },
    focus() { win.dispatchEvent(new Event('focus')) },
  }
}

describe('startTabMonitor', () => {
  let b, cb, stop
  beforeEach(() => {
    vi.useFakeTimers()
    b  = fakeBrowser()
    cb = { onLeave: vi.fn(), onReturn: vi.fn() }
    stop = startTabMonitor(cb, { doc: b.doc, win: b.win })
  })
  afterEach(() => { stop(); vi.useRealTimers() })

  it('merges blur + hidden into ONE tab-switch episode', () => {
    b.blur(); b.hide()
    vi.advanceTimersByTime(5_000)
    b.show(); b.focus()
    expect(cb.onLeave).toHaveBeenCalledOnce()
    expect(cb.onLeave.mock.calls[0][0].reason).toBe('tab_hidden')
    expect(cb.onReturn).toHaveBeenCalledOnce()
    expect(cb.onReturn.mock.calls[0][0]).toMatchObject({ reason: 'tab_hidden', awayMs: 5_000 })
  })

  it('records the time the student left, not the time it was classified', () => {
    const t0 = Date.now()
    b.hide()
    vi.advanceTimersByTime(1_000)
    expect(cb.onLeave.mock.calls[0][0].at).toBe(t0)
  })

  it('classifies blur without hiding as focus_lost (another app in front)', () => {
    b.blur()
    vi.advanceTimersByTime(3_000)
    b.focus()
    expect(cb.onLeave.mock.calls[0][0].reason).toBe('focus_lost')
    expect(cb.onReturn.mock.calls[0][0].awayMs).toBe(3_000)
  })

  it('does not return until the tab is both visible and focused', () => {
    b.blur(); b.hide()
    vi.advanceTimersByTime(1_000)
    b.show()                           // visible but still unfocused
    expect(cb.onReturn).not.toHaveBeenCalled()
    b.focus()
    expect(cb.onReturn).toHaveBeenCalledOnce()
  })

  it('still reports a very short departure (shorter than the settle period)', () => {
    b.blur()
    vi.advanceTimersByTime(100)
    b.focus()
    expect(cb.onLeave).toHaveBeenCalledOnce()
    expect(cb.onReturn).toHaveBeenCalledWith(expect.objectContaining({ awayMs: 100 }))
    vi.advanceTimersByTime(1_000)
    expect(cb.onLeave).toHaveBeenCalledOnce()   // settle timer was cancelled
  })

  it('counts separate departures separately', () => {
    for (let i = 0; i < 3; i++) {
      b.blur(); b.hide(); vi.advanceTimersByTime(1_000); b.show(); b.focus()
    }
    expect(cb.onLeave).toHaveBeenCalledTimes(3)
    expect(cb.onReturn).toHaveBeenCalledTimes(3)
  })

  it('reports immediately if the exam starts while the page is hidden', () => {
    const b2 = fakeBrowser(); b2.doc.hidden = true
    const onLeave = vi.fn()
    const stop2 = startTabMonitor({ onLeave }, { doc: b2.doc, win: b2.win })
    vi.advanceTimersByTime(500)
    expect(onLeave).toHaveBeenCalledWith(expect.objectContaining({ reason: 'tab_hidden' }))
    stop2()
  })

  it('removes its listeners on stop()', () => {
    stop()
    b.blur(); b.hide()
    vi.advanceTimersByTime(1_000)
    expect(cb.onLeave).not.toHaveBeenCalled()
  })
})
