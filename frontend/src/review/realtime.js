/**
 * realtime.js
 * Subscribes a faculty client to live changes for one exam over Supabase
 * Realtime (a WebSocket). The server delivers a change only if the
 * faculty member's RLS allows them to read that row.
 *
 * Each change is reduced to "exam session X changed"; the caller re-reads
 * that session. Re-reading (rather than trusting payload contents) keeps
 * large breakdowns and RLS-filtered embeds consistent, and the caller
 * also re-syncs everything whenever the socket (re)connects, so changes
 * missed while disconnected are not lost.
 */

import { sessionIdFromChange } from './liveSessions'

export const MONITOR_TABLES = ['exam_sessions', 'proctoring_sessions', 'risk_scores', 'session_reviews']

/**
 * @param {object}   client   Supabase client (or anything with .channel/.removeChannel)
 * @param {string}   examId
 * @param {object}   handlers
 * @param {function} handlers.onSessionChanged  (examSessionId, table, payload) => void
 * @param {function} [handlers.onStatus]        ('connecting'|'live'|'reconnecting'|'error', detail?) => void
 * @param {function} [handlers.onResync]        () => void — (re)connected: reload everything
 * @returns {function} unsubscribe
 */
export function subscribeToExam(client, examId, { onSessionChanged, onStatus, onResync }) {
  const channel = client.channel(`exam-monitor:${examId}`)

  for (const table of MONITOR_TABLES) {
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table, filter: `exam_id=eq.${examId}` },
      payload => {
        const id = sessionIdFromChange(table, payload)
        if (id) onSessionChanged(id, table, payload)
      },
    )
  }

  let everLive = false
  onStatus?.('connecting')
  channel.subscribe((status, err) => {
    if (status === 'SUBSCRIBED') {
      onStatus?.('live')
      onResync?.()          // first connect and every reconnect
      everLive = true
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      onStatus?.(everLive ? 'reconnecting' : 'error', err?.message ?? status)
    } else if (status === 'CLOSED') {
      onStatus?.('reconnecting')
    }
  })

  return () => { client.removeChannel(channel) }
}

/**
 * Coalesces bursts of changes for the same session (an event insert also
 * updates risk_scores) into one reload per session.
 */
export function createSessionReloader(reload, { delayMs = 250 } = {}) {
  const timers = new Map()
  return {
    schedule(id) {
      clearTimeout(timers.get(id))
      timers.set(id, setTimeout(() => { timers.delete(id); reload(id) }, delayMs))
    },
    cancelAll() {
      timers.forEach(clearTimeout)
      timers.clear()
    },
  }
}
