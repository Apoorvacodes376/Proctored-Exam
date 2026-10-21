// End-to-end over a real WebSocket: the real @supabase/supabase-js client
// (as used by the faculty dashboard) talks to a local server that speaks
// the Supabase Realtime (Phoenix v2) protocol. Checks the filters sent on
// the wire, change delivery, and resync after a dropped connection.
//
// What this does NOT cover: the hosted Realtime server's RLS filtering
// (covered by the database tests: faculty can only SELECT their own rows)
// and Postgres logical replication itself.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocketServer } from 'ws'
import { createClient } from '@supabase/supabase-js'
import { subscribeToExam, MONITOR_TABLES } from '../realtime'

function startFakeRealtime() {
  const wss = new WebSocketServer({ port: 0 })
  const state = { sockets: new Set(), joins: [], urls: [] }
  wss.on('connection', (ws, req) => {
    state.urls.push(req.url)
    state.sockets.add(ws)
    ws.on('close', () => state.sockets.delete(ws))
    ws.on('message', raw => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(raw.toString())
      const reply = response => ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response }]))
      if (event === 'heartbeat' || event === 'phx_leave' || event === 'access_token') return reply({})
      if (event === 'phx_join') {
        const filters = payload.config.postgres_changes
        state.joins.push({ topic, filters, joinRef, ws })
        reply({ postgres_changes: filters.map((f, i) => ({ ...f, id: 100 + i })) })
      }
    })
  })
  return {
    port: () => wss.address().port,
    state,
    /** Push a postgres change to every joined channel whose filter matches the table. */
    pushChange(table, type, record) {
      for (const j of state.joins) {
        const ids = j.filters.map((f, i) => (f.table === table ? 100 + i : null)).filter(Boolean)
        if (!ids.length || j.ws.readyState !== 1) continue
        j.ws.send(JSON.stringify([null, null, j.topic, 'postgres_changes', {
          ids,
          data: {
            schema: 'public', table, type, commit_timestamp: new Date().toISOString(), errors: null,
            columns: Object.keys(record).map(name => ({ name, type: 'text' })),
            record, old_record: type === 'UPDATE' ? { id: record.id } : undefined,
          },
        }]))
      }
    },
    dropConnections() { for (const s of state.sockets) s.terminate() },
    close: () => new Promise(r => wss.close(r)),
  }
}

const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('timed out waiting for condition')
}

describe('faculty dashboard realtime over a WebSocket', () => {
  let server, client, unsubscribe
  const changes = []
  const statuses = []
  let resyncs = 0
  const onResync = () => { resyncs++ }

  beforeAll(async () => {
    server = startFakeRealtime()
    client = createClient(`http://127.0.0.1:${server.port()}`, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 100 } },
    })
    unsubscribe = subscribeToExam(client, 'exam-42', {
      onSessionChanged: (id, table) => changes.push({ id, table }),
      onStatus: s => statuses.push(s),
      onResync,
    })
    await waitFor(() => statuses.includes('live'))
  })

  afterAll(async () => {
    unsubscribe?.()
    client?.realtime.disconnect()
    await server?.close()
  })

  it('connects to the Realtime websocket endpoint with the API key', () => {
    expect(server.state.urls[0]).toMatch(/^\/realtime\/v1\/websocket\?.*apikey=test-anon-key/)
  })

  it('joins one channel with exam-filtered postgres_changes for each monitor table', () => {
    const join = server.state.joins[0]
    expect(join.topic).toBe('realtime:exam-monitor:exam-42')
    expect(join.filters).toEqual(MONITOR_TABLES.map(table =>
      ({ event: '*', schema: 'public', table, filter: 'exam_id=eq.exam-42' })))
    expect(resyncs).toBe(1)
  })

  it('delivers a risk score change pushed by the server', async () => {
    server.pushChange('risk_scores', 'UPDATE', { id: 'r1', exam_session_id: 'es-1', exam_id: 'exam-42', score: '51.5' })
    await waitFor(() => changes.some(c => c.id === 'es-1'))
    expect(changes.at(-1)).toEqual({ id: 'es-1', table: 'risk_scores' })
  })

  it('delivers heartbeats and new sessions', async () => {
    server.pushChange('proctoring_sessions', 'UPDATE', { id: 'ps-2', exam_session_id: 'es-2', exam_id: 'exam-42' })
    server.pushChange('exam_sessions', 'INSERT', { id: 'es-3', exam_id: 'exam-42', status: 'in_progress' })
    await waitFor(() => changes.some(c => c.id === 'es-3'))
    expect(changes).toEqual(expect.arrayContaining([
      { id: 'es-2', table: 'proctoring_sessions' },
      { id: 'es-3', table: 'exam_sessions' },
    ]))
  })

  it('ignores tables it did not subscribe to', async () => {
    const before = changes.length
    server.pushChange('proctoring_events', 'INSERT', { id: 'e', exam_session_id: 'es-x' })
    await new Promise(r => setTimeout(r, 200))
    expect(changes.length).toBe(before)
  })

  it('reconnects after the socket drops and asks the page to resync', async () => {
    server.dropConnections()
    await waitFor(() => server.state.joins.length >= 2 && resyncs >= 2, 15_000)
    expect(statuses).toContain('reconnecting')
    server.pushChange('risk_scores', 'UPDATE', { id: 'r4', exam_session_id: 'es-4', exam_id: 'exam-42' })
    await waitFor(() => changes.some(c => c.id === 'es-4'))
  }, 20_000)
})
