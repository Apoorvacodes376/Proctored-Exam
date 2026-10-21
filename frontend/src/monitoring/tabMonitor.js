/**
 * tabMonitor.js
 * Module 6: Tab-Switch & Focus Detection
 *
 * Uses the Page Visibility API and window focus/blur to detect when the
 * student leaves the exam tab. Browsers fire several events for one
 * departure (switching tabs fires `blur` then `visibilitychange`), so the
 * events are merged into a single episode:
 *
 *   onLeave({ reason, at })          once, after a short settle period
 *   onReturn({ reason, at, awayMs }) when the exam tab is visible and focused again
 *
 * reason:
 *   'tab_hidden'  the exam tab was hidden (switched tab, minimised, locked screen)
 *   'focus_lost'  the tab stayed visible but the window lost focus
 *                 (another app or window in front, e.g. a side-by-side window)
 *
 * Browser limitations: the page cannot see which tab or application the
 * student switched to, nor anything on a second screen or another device.
 * Focus can also move to browser UI (address bar, extension pop-ups,
 * permission prompts), which is indistinguishable from another app.
 *
 * No React, no Supabase. `doc` / `win` are injectable for tests.
 */

export const TAB_DEFAULTS = {
  settleMs: 300,   // let blur + visibilitychange arrive before classifying
}

/**
 * @param {object} callbacks
 * @param {function} [callbacks.onLeave]
 * @param {function} [callbacks.onReturn]
 * @param {object}   [options]
 * @param {Document} [options.doc]
 * @param {Window}   [options.win]
 * @param {number}   [options.settleMs]
 * @returns {function} stop
 */
export function startTabMonitor({ onLeave, onReturn } = {}, options = {}) {
  const doc = options.doc ?? globalThis.document
  const win = options.win ?? globalThis.window
  const settleMs = options.settleMs ?? TAB_DEFAULTS.settleMs

  let focused   = doc.hasFocus?.() ?? true
  let leftAt    = null        // start of the current away episode
  let wasHidden = false       // hidden at any point during the episode
  let reported  = false       // onLeave fired for this episode
  let settleId  = null

  const isAway = () => doc.hidden || !focused

  function evaluate() {
    const now = Date.now()
    if (isAway()) {
      if (doc.hidden) wasHidden = true
      if (leftAt === null) {
        leftAt = now
        settleId = setTimeout(() => {
          settleId = null
          if (leftAt === null) return
          reported = true
          onLeave?.({ reason: wasHidden ? 'tab_hidden' : 'focus_lost', at: leftAt })
        }, settleMs)
      }
    } else if (leftAt !== null) {
      clearTimeout(settleId)
      settleId = null
      if (!reported) {
        // Back before the settle period ended: a real but very short
        // departure. Report it as a leave+return pair so it isn't lost.
        onLeave?.({ reason: wasHidden ? 'tab_hidden' : 'focus_lost', at: leftAt })
      }
      onReturn?.({ reason: wasHidden ? 'tab_hidden' : 'focus_lost', at: now, awayMs: now - leftAt })
      leftAt = null; wasHidden = false; reported = false
    }
  }

  const onVisibility = () => evaluate()
  const onBlur  = () => { focused = false; evaluate() }
  const onFocus = () => { focused = true;  evaluate() }

  doc.addEventListener('visibilitychange', onVisibility)
  win.addEventListener('blur',  onBlur)
  win.addEventListener('focus', onFocus)
  evaluate()

  return function stop() {
    clearTimeout(settleId)
    doc.removeEventListener('visibilitychange', onVisibility)
    win.removeEventListener('blur',  onBlur)
    win.removeEventListener('focus', onFocus)
  }
}
