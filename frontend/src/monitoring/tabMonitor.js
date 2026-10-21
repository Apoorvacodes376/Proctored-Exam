/**
 * tabMonitor.js
 * Module 6: Tab-Switch & Focus Detection
 *
 * Uses the Page Visibility API (document.visibilitychange) and
 * window focus/blur events to detect when the student leaves the
 * exam tab or switches to another application.
 *
 * Browser limitation: browsers cannot detect which specific
 * application the student switched to. We can only detect that
 * the exam tab lost focus or became hidden.
 *
 * Fully independent — no React, no Supabase.
 */

/**
 * Start tab-switch monitoring.
 *
 * @param {object} callbacks
 * @param {function} callbacks.onTabHidden   (timestamp: number) => void
 * @param {function} callbacks.onTabVisible  (hiddenDurationMs: number) => void
 * @param {function} callbacks.onWindowBlur  (timestamp: number) => void
 * @param {function} callbacks.onWindowFocus () => void
 * @returns {function} stop
 */
export function startTabMonitor({ onTabHidden, onTabVisible, onWindowBlur, onWindowFocus }) {
  let hiddenAt = null

  function handleVisibilityChange() {
    if (document.hidden) {
      hiddenAt = Date.now()
      onTabHidden?.(hiddenAt)
    } else {
      const duration = hiddenAt ? Date.now() - hiddenAt : 0
      hiddenAt = null
      onTabVisible?.(duration)
    }
  }

  function handleBlur() {
    onWindowBlur?.(Date.now())
  }

  function handleFocus() {
    onWindowFocus?.()
  }

  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('blur',  handleBlur)
  window.addEventListener('focus', handleFocus)

  return function stop() {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('blur',  handleBlur)
    window.removeEventListener('focus', handleFocus)
  }
}
