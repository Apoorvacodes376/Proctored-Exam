import { useState, useEffect, useRef } from 'react'
import { Clock } from 'lucide-react'

/** Whole seconds remaining, rounded up so the student is never cut short. */
export const secondsLeft = (endsAt, now = Date.now()) => Math.max(0, Math.ceil((endsAt - now) / 1000))

// Ticks on a wall-clock interval. (The previous version re-armed a
// timeout only when the displayed second changed; a tick that landed in
// the same second set identical state, React skipped the re-render, and
// the countdown — and automatic submission — stalled until something else
// re-rendered the page.)
export default function ExamTimer({ endsAt, onExpire }) {
  const [secsLeft, setSecsLeft] = useState(() => secondsLeft(endsAt))
  const firedRef = useRef(false)
  const onExpireRef = useRef(onExpire)
  useEffect(() => { onExpireRef.current = onExpire }, [onExpire])

  useEffect(() => {
    function tick() {
      const next = secondsLeft(endsAt)
      setSecsLeft(next)
      if (next <= 0 && !firedRef.current) {
        firedRef.current = true
        onExpireRef.current?.()
      }
    }
    tick()
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [endsAt])

  const mins = Math.floor(secsLeft / 60)
  const secs = secsLeft % 60
  const critical = secsLeft <= 300  // last 5 minutes

  return (
    <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-mono font-semibold tabular-nums transition-colors ${
      critical
        ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
        : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
    }`}>
      <Clock size={14} strokeWidth={1.75} className={critical ? 'animate-pulse' : ''} />
      {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
    </div>
  )
}
