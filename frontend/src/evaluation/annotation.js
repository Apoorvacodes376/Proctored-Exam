/**
 * annotation.js — helpers for entering ground truth as offsets from the
 * start of an exam session (how scripted-trial protocols and video
 * timestamps are usually written down).
 */

/** "75", "1:15", "0:01:15" or "1:15.5" → seconds; null for empty; NaN for invalid. */
export function parseOffset(text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return NaN
  const parts = s.split(':').map(Number)
  if (parts.slice(1).some(p => p >= 60)) return NaN
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

/** seconds → "m:ss" or "h:mm:ss" (with tenths when fractional). */
export function formatOffset(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return ''
  const sign = seconds < 0 ? '-' : ''
  let s = Math.abs(seconds)
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60);   s -= m * 60
  const sec = Number.isInteger(s) ? String(s).padStart(2, '0') : s.toFixed(1).padStart(4, '0')
  return h ? `${sign}${h}:${String(m).padStart(2, '0')}:${sec}` : `${sign}${m}:${sec}`
}

/** Offset (s) from session start → ISO timestamp. */
export const offsetToIso = (sessionStartIso, seconds) =>
  new Date(new Date(sessionStartIso).getTime() + seconds * 1000).toISOString()

/** ISO timestamp → offset (s) from session start. */
export const isoToOffset = (sessionStartIso, iso) =>
  iso == null ? null : (new Date(iso).getTime() - new Date(sessionStartIso).getTime()) / 1000

/**
 * Validate an interval form. Returns { errors: string[], value } where
 * value is ready to insert into ground_truth_intervals.
 */
export function intervalFromForm(form, sessionStartIso) {
  const errors = []
  const start = parseOffset(form.start)
  const end = parseOffset(form.end)
  if (start == null) errors.push('Enter when the behaviour started.')
  else if (Number.isNaN(start)) errors.push('Start must look like 75, 1:15 or 0:01:15.')
  if (Number.isNaN(end)) errors.push('End must look like 75, 1:15 or 0:01:15.')
  else if (end != null && start != null && !Number.isNaN(start) && end < start) errors.push('End must not be before start.')
  if (!form.category) errors.push('Choose a category.')
  if (errors.length) return { errors, value: null }
  return {
    errors,
    value: {
      category: form.category,
      starts_at: offsetToIso(sessionStartIso, start),
      ends_at: end == null ? null : offsetToIso(sessionStartIso, end),
      label: form.label?.trim() || null,
      notes: form.notes?.trim() || null,
    },
  }
}
