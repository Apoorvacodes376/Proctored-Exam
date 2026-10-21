import { useState, useEffect, useRef } from 'react'
import { Clock } from 'lucide-react'

export default function ExamTimer({ endsAt, onExpire }) {
  const [secsLeft, setSecsLeft] = useState(() =>
    Math.max(0, Math.floor((endsAt - Date.now()) / 1000))
  )
  const firedRef = useRef(false)

  useEffect(() => {
    if (secsLeft <= 0) {
      if (!firedRef.current) { firedRef.current = true; onExpire() }
      return
    }
    const id = setTimeout(() => {
      const next = Math.max(0, Math.floor((endsAt - Date.now()) / 1000))
      setSecsLeft(next)
      if (next <= 0 && !firedRef.current) { firedRef.current = true; onExpire() }
    }, 500)
    return () => clearTimeout(id)
  }, [secsLeft, endsAt, onExpire])

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
