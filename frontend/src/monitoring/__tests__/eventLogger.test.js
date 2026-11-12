import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventLogger, SEVERITY } from '../eventLogger'

/**
 * Minimal fake of the supabase-js surface the logger uses. Records every
 * write; `fail` lets a test make a table/op return an error.
 */
function fakeSupabase() {
  const db = { proctoring_sessions: [], proctoring_events: [], proctoring_snapshots: [] }
  const uploads = []
  const rpcs    = []
  const fail    = {}                     // e.g. fail['proctoring_events.insert'] = 2 (times)

  const shouldFail = k => (fail[k] > 0 ? (fail[k]--, { message: `${k} failed` }) : null)

  function from(table) {
    let filter = null
    const q = {
      select() { return q },
      eq(col, val) { filter = [col, val]; return q },
      async maybeSingle() {
        const row = db[table].find(r => r[filter[0]] === filter[1])
        return { data: row ?? null, error: null }
      },
      async insert(row) {
        const error = shouldFail(`${table}.insert`)
        if (!error) {
          if (db[table].some(r => r.id === row.id)) return { error: { code: '23505', message: 'duplicate' } }
          db[table].push(row)
        }
        return { error }
      },
      update(patch) {
        return { eq: async (col, val) => {
          db[table].filter(r => r[col] === val).forEach(r => Object.assign(r, patch))
          return { error: null }
        } }
      },
    }
    return q
  }

  return {
    db, uploads, rpcs, fail,
    from,
    storage: { from: bucket => ({ upload: async (path, blob, opts) => {
      const error = shouldFail('storage.upload')
      if (!error) uploads.push({ bucket, path, blob, opts })
      return { error }
    } }) },
    rpc: async (fn, args) => {
      const error = shouldFail(`rpc.${fn}`)
      if (!error) rpcs.push({ fn, args })
      return { error }
    },
  }
}

let seq
const uuid = () => `id-${++seq}`

function setup(overrides = {}) {
  const client = fakeSupabase()
  let t = 1_700_000_000_000
  const clock = { now: () => t, advance: ms => { t += ms } }
  const captureFrame = vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' }))
  const logger = createEventLogger({
    client, examSessionId: 'es-1', studentId: 'stu-1', examId: 'exam-1',
    captureFrame, uuid, now: clock.now, ...overrides,
  })
  return { client, clock, captureFrame, logger }
}

describe('createEventLogger', () => {
  beforeEach(() => { seq = 0 })

  it('creates the proctoring session once and reuses it', async () => {
    const { client, logger } = setup()
    const a = await logger.start()
    const b = await logger.start()
    expect(a).toBe(b)
    expect(client.db.proctoring_sessions).toHaveLength(1)
    expect(client.db.proctoring_sessions[0]).toMatchObject({ exam_session_id: 'es-1', stream_status: 'active' })
  })

  it('resumes an existing session on re-entry (page reload)', async () => {
    const { client, logger } = setup()
    client.db.proctoring_sessions.push({ id: 'ps-old', exam_session_id: 'es-1', stream_status: 'ended' })
    expect(await logger.start()).toBe('ps-old')
    expect(client.db.proctoring_sessions[0].stream_status).toBe('active')
  })

  it('refuses to log before start()', async () => {
    const { logger } = setup()
    await expect(logger.log({ eventType: 'tab_switch' })).rejects.toThrow(/start/)
  })

  it('records student, exam, type, timestamp, severity and confidence', async () => {
    const { client, logger } = setup()
    await logger.start()
    await logger.log({ eventType: 'phone_detected', confidence: 0.876543, metadata: { className: 'cell phone' } })
    expect(client.db.proctoring_events[0]).toEqual({
      id: expect.any(String),
      proctoring_session_id: expect.any(String),
      student_id: 'stu-1',
      exam_id: 'exam-1',
      event_type: 'phone_detected',
      severity: SEVERITY.phone_detected,
      confidence: 0.8765,
      occurred_at: new Date(1_700_000_000_000).toISOString(),
      metadata: { className: 'cell phone' },
    })
  })

  it('omits confidence when the detector has none, and clamps out-of-range values', async () => {
    const { client, logger } = setup()
    await logger.start()
    await logger.log({ eventType: 'tab_switch' })
    await logger.log({ eventType: 'focus_lost', confidence: 1.7 })
    expect(client.db.proctoring_events[0]).not.toHaveProperty('confidence')
    expect(client.db.proctoring_events[1].confidence).toBe(1)
  })

  it('uses the time the event happened, when given', async () => {
    const { client, logger } = setup()
    await logger.start()
    await logger.log({ eventType: 'tab_switch', occurredAt: 1_699_999_999_000 })
    expect(client.db.proctoring_events[0].occurred_at).toBe(new Date(1_699_999_999_000).toISOString())
  })

  it('captures evidence, stores it under the session folder and links it to the event', async () => {
    const { client, logger } = setup()
    await logger.start()
    const rec = await logger.log({ eventType: 'multiple_faces', confidence: 0.9, evidence: true })

    expect(client.uploads).toHaveLength(1)
    expect(client.uploads[0]).toMatchObject({ bucket: 'proctoring-frames', path: `es-1/${rec.id}.jpg`, opts: { contentType: 'image/jpeg', upsert: false } })
    const snap = client.db.proctoring_snapshots[0]
    expect(snap).toMatchObject({ storage_path: `es-1/${rec.id}.jpg`, frame_type: 'webcam' })
    expect(client.db.proctoring_events[0].snapshot_id).toBe(snap.id)
  })

  it('still logs the event if evidence capture fails, noting why', async () => {
    const { client, logger } = setup({ captureFrame: async () => null })
    await logger.start()
    await logger.log({ eventType: 'face_not_detected', evidence: true })
    expect(client.db.proctoring_events[0].snapshot_id).toBeUndefined()
    expect(client.db.proctoring_events[0].metadata.evidence_error).toMatch(/unavailable/)
  })

  it('applies the cooldown BEFORE capturing evidence (no orphan snapshots)', async () => {
    const { client, clock, captureFrame, logger } = setup()
    await logger.start()
    expect(await logger.log({ eventType: 'phone_detected', evidence: true })).not.toBeNull()
    clock.advance(5_000)
    expect(await logger.log({ eventType: 'phone_detected', evidence: true })).toBeNull()
    expect(captureFrame).toHaveBeenCalledTimes(1)
    expect(client.uploads).toHaveLength(1)
    clock.advance(30_000)
    expect(await logger.log({ eventType: 'phone_detected', evidence: true })).not.toBeNull()
  })

  it('cooldowns are per dedupe key (a book does not suppress a phone)', async () => {
    const { client, logger } = setup()
    await logger.start()
    await logger.log({ eventType: 'object_detected', dedupeKey: 'object:book' })
    await logger.log({ eventType: 'object_detected', dedupeKey: 'object:laptop' })
    expect(client.db.proctoring_events).toHaveLength(2)
  })

  it('logs every tab departure (no cooldown)', async () => {
    const { client, logger } = setup()
    await logger.start()
    for (let i = 0; i < 3; i++) await logger.log({ eventType: 'tab_switch' })
    expect(client.db.proctoring_events).toHaveLength(3)
  })

  it('closes an episode through the RPC', async () => {
    const { client, clock, logger } = setup()
    await logger.start()
    const rec = await logger.log({ eventType: 'camera_interrupted' })
    clock.advance(12_000)
    await logger.close(rec.id)
    expect(client.rpcs).toEqual([{ fn: 'close_proctoring_event', args: { p_event_id: rec.id, p_ended_at: new Date(1_700_000_012_000).toISOString() } }])
  })

  it('queues failed writes and retries them in order (insert before close)', async () => {
    const { client, logger } = setup()
    await logger.start()
    client.fail['proctoring_events.insert'] = 1
    const rec = await logger.log({ eventType: 'tab_switch' })
    expect(rec.sent).toBe(false)
    await logger.close(rec.id)
    expect(client.rpcs).toHaveLength(0)                 // held back behind the insert
    expect(logger.pending).toBe(2)

    expect(await logger.flush()).toBe(true)
    expect(client.db.proctoring_events).toHaveLength(1)
    expect(client.rpcs).toHaveLength(1)
    expect(logger.pending).toBe(0)
  })

  it('treats a duplicate-id retry as success', async () => {
    const { client, logger } = setup()
    await logger.start()
    const rec = await logger.log({ eventType: 'tab_switch' })
    // Simulate: the first insert landed but the client saw an error.
    client.db.proctoring_events.length = 0
    client.fail['proctoring_events.insert'] = 1
    await logger.log({ eventType: 'focus_lost' })
    client.db.proctoring_events.push({ id: rec.id })
    client.db.proctoring_events.push({ id: 'id-' + seq })
    expect(await logger.flush()).toBe(true)
  })

  it('end() flushes and marks the session ended', async () => {
    const { client, logger } = setup()
    await logger.start()
    client.fail['proctoring_events.insert'] = 1
    await logger.log({ eventType: 'tab_switch' })
    await logger.end()
    expect(client.db.proctoring_events).toHaveLength(1)
    expect(client.db.proctoring_sessions[0].stream_status).toBe('ended')
  })
})
