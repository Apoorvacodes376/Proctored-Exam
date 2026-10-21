import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { toMonitorRow, alertCounts, openConditions, sessionIdFromChange, sortRows, ONLINE_WINDOW_MS } from '../liveSessions'
import { categoryRows, eventTimeline, identitySummary, formatDuration, formatConfidence, reviewReasonText } from '../riskView'
import { createEvidenceResolver } from '../evidence'
import { subscribeToExam, createSessionReloader, MONITOR_TABLES } from '../realtime'

const NOW = Date.parse('2026-01-01T10:10:00Z')

const breakdown = {
  score: 46.25, review_threshold: 40, total_events: 7,
  type_counts: { tab_switch: 3, focus_lost: 1, face_not_detected: 1, phone_detected: 1, speech_detected: 1 },
  categories: {
    objects:       { label: 'Prohibited objects', weight: 25, saturation: 2, effective: 0.9, normalised: 0.45, contribution: 11.25, events: 1, counted: 1, duplicates: 0, dismissed: 0, below_confidence: 0, duration_s: 0 },
    tab_switching: { label: 'Leaving the exam',   weight: 15, saturation: 5, effective: 5,   normalised: 1,    contribution: 15,    events: 4, counted: 3, duplicates: 1, dismissed: 0, below_confidence: 0, duration_s: 80 },
    face_absence:  { label: 'Face not visible',   weight: 20, saturation: 4, effective: 4,   normalised: 1,    contribution: 20,    events: 1, counted: 1, duplicates: 0, dismissed: 0, below_confidence: 0, duration_s: 95 },
  },
  events: [
    { id: 'e3', type: 'face_not_detected', occurred_at: '2026-01-01T10:08:25Z', ended_at: null, duration_s: 95, status: 'counted' },
    { id: 'e1', type: 'phone_detected',    occurred_at: '2026-01-01T10:01:00Z', ended_at: null, duration_s: null, confidence: 0.9, status: 'counted', snapshot_id: 's1' },
    { id: 'e2', type: 'tab_switch',        occurred_at: '2026-01-01T10:02:00Z', ended_at: '2026-01-01T10:02:20Z', duration_s: 20, status: 'duplicate' },
    { id: 'e4', type: 'multiple_faces',    occurred_at: '2026-01-01T10:05:00Z', ended_at: null, duration_s: 300, status: 'dismissed' },
  ],
  identity: { attempts: 3, passed: 1, failed: 1, inconclusive: 1, flag: true, reasons: ['repeated_failures'], best_distance: 0.47 },
}

const row = (over = {}) => ({
  id: 'es1', exam_id: 'x1', status: 'in_progress', started_at: '2026-01-01T10:00:00Z',
  student: { id: 'st1', name: 'Alice', student_id: 'A1' },
  proctoring: [{ id: 'ps1', live_status: { camera: 'ok', microphone: 'lost', face: 'present', away: false }, last_heartbeat_at: new Date(NOW - 5_000).toISOString() }],
  risk: { score: '46.25', risk_level: 'high', needs_review: true, identity_flag: true, review_reasons: ['risk_score', 'identity'], breakdown },
  review: null,
  ...over,
})

describe('liveSessions', () => {
  it('builds a dashboard row with live status, counts and score', () => {
    const r = toMonitorRow(row(), NOW)
    expect(r).toMatchObject({
      name: 'Alice', studentNo: 'A1', examStatus: 'in_progress', online: true, lastSeenMs: 5_000,
      camera: 'ok', microphone: 'lost', score: 46.25, level: 'high', needsReview: true, identityFlag: true,
      reviewStatus: 'not_reviewed',
    })
    expect(r.counts).toEqual({ missingFace: 1, multiplePeople: 0, objects: 1, audio: 1, tabSwitches: 4, media: 0, total: 7 })
  })

  it('an open face-absence episode overrides the self-reported face status', () => {
    expect(toMonitorRow(row(), NOW).face).toBe('absent')
  })

  it('a dismissed open episode is not shown as ongoing', () => {
    expect(openConditions(breakdown).multiplePeople).toBeUndefined()
    expect(openConditions(breakdown).faceMissing).toBe(true)
  })

  it('marks a student offline after the heartbeat window and stops trusting live status', () => {
    const stale = row({ proctoring: { live_status: { camera: 'ok' }, last_heartbeat_at: new Date(NOW - ONLINE_WINDOW_MS - 1).toISOString() } })
    const r = toMonitorRow(stale, NOW)
    expect(r.online).toBe(false)
    expect(r.camera).toBe('unknown')
  })

  it('submitted sessions are never shown as online', () => {
    expect(toMonitorRow(row({ status: 'submitted' }), NOW).online).toBe(false)
  })

  it('handles a session with no proctoring or risk rows yet', () => {
    const r = toMonitorRow({ id: 'es2', status: 'in_progress', student: { name: 'Bob' }, proctoring: [], risk: null }, NOW)
    expect(r).toMatchObject({ online: false, score: null, needsReview: false })
    expect(alertCounts(null).total).toBe(0)
  })

  it('maps Realtime changes to exam sessions', () => {
    expect(sessionIdFromChange('exam_sessions', { new: { id: 'a' } })).toBe('a')
    expect(sessionIdFromChange('risk_scores', { new: { exam_session_id: 'b' } })).toBe('b')
    expect(sessionIdFromChange('session_reviews', { new: {}, old: { exam_session_id: 'c' } })).toBe('c')
  })

  it('sorts flagged, then highest score', () => {
    const rows = [
      { name: 'B', needsReview: false, score: 90 },
      { name: 'A', needsReview: true,  score: 41 },
      { name: 'C', needsReview: true,  score: 70 },
    ]
    expect(sortRows(rows).map(r => r.name)).toEqual(['C', 'A', 'B'])
  })
})

describe('riskView', () => {
  it('lists categories by contribution with an explanation', () => {
    const rows = categoryRows(breakdown)
    expect(rows.map(r => r.key)).toEqual(['face_absence', 'tab_switching', 'objects'])
    expect(rows[2].explanation).toBe('0.9 effective of 2 to saturate → 45% × weight 25')
  })

  it('orders events chronologically and labels them', () => {
    const t = eventTimeline(breakdown)
    expect(t.map(e => e.id)).toEqual(['e1', 'e2', 'e4', 'e3'])
    expect(t[0]).toMatchObject({ label: 'Phone detected', scored: true, open: false })
    expect(t[3]).toMatchObject({ open: true })
    expect(t[2]).toMatchObject({ statusLabel: 'Dismissed by reviewer', scored: false })
  })

  it('summarises identity separately from the score', () => {
    expect(identitySummary(breakdown.identity)).toMatchObject({
      flag: true, headline: '3 attempts · 1 passed · 1 failed · 1 inconclusive',
      reasons: ['Repeated failed or inconclusive face matches'],
    })
    expect(identitySummary({ attempts: 0 }).flag).toBe(false)
  })

  it('formats durations, confidence and reasons', () => {
    expect(formatDuration(45)).toBe('45 s')
    expect(formatDuration(125)).toBe('2 min 5 s')
    expect(formatDuration(null)).toBe('—')
    expect(formatConfidence(0.876)).toBe('88%')
    expect(reviewReasonText(['risk_score', 'identity'], breakdown)).toEqual([
      'Behavioural risk score 46.25 ≥ review threshold 40',
      'Identity verification needs attention',
    ])
  })
})

describe('evidence resolver', () => {
  function fakeClient({ snap = { storage_path: 'es1/e1.jpg', captured_at: 't' }, signError = null } = {}) {
    const calls = { select: 0, sign: [] }
    return {
      calls,
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { calls.select++; return { data: snap, error: null } } }) }) }),
      storage: { from: bucket => ({ createSignedUrl: async (path, ttl) => {
        calls.sign.push({ bucket, path, ttl })
        return signError ? { data: null, error: { message: signError } } : { data: { signedUrl: `https://signed/${path}?t=${calls.sign.length}` }, error: null }
      } }) },
    }
  }

  it('resolves a snapshot to a short-lived signed URL in the private bucket', async () => {
    const c = fakeClient()
    const r = await createEvidenceResolver(c, { ttlS: 120 }).get('s1')
    expect(r).toMatchObject({ url: 'https://signed/es1/e1.jpg?t=1', path: 'es1/e1.jpg' })
    expect(c.calls.sign[0]).toEqual({ bucket: 'proctoring-frames', path: 'es1/e1.jpg', ttl: 120 })
  })

  it('caches until shortly before expiry, then re-signs', async () => {
    let t = 0
    const c = fakeClient()
    const ev = createEvidenceResolver(c, { ttlS: 300, now: () => t })
    await Promise.all([ev.get('s1'), ev.get('s1')])
    expect(c.calls.sign).toHaveLength(1)
    t = 269_000
    await ev.get('s1')
    expect(c.calls.sign).toHaveLength(1)
    t = 271_000
    expect((await ev.get('s1')).url).toMatch(/t=2$/)
  })

  it('reports inaccessible or missing evidence instead of throwing', async () => {
    expect(await createEvidenceResolver(fakeClient({ snap: null })).get('s1')).toEqual({ error: expect.stringMatching(/not found/) })
    expect(await createEvidenceResolver(fakeClient({ signError: 'Object not found' })).get('s1')).toEqual({ error: 'Object not found' })
    expect(await createEvidenceResolver(fakeClient()).get(null)).toEqual({ error: expect.any(String) })
  })
})

describe('realtime subscription (fake channel)', () => {
  function fakeClient() {
    const ch = { bindings: [], on(type, filter, cb) { this.bindings.push({ type, filter, cb }); return this }, subscribe(cb) { this.statusCb = cb; return this } }
    return { ch, channel: vi.fn(() => ch), removeChannel: vi.fn() }
  }

  it('subscribes to every monitor table filtered to the exam', () => {
    const c = fakeClient()
    subscribeToExam(c, 'exam-1', { onSessionChanged: () => {} })
    expect(c.ch.bindings.map(b => b.filter)).toEqual(MONITOR_TABLES.map(table =>
      ({ event: '*', schema: 'public', table, filter: 'exam_id=eq.exam-1' })))
  })

  it('maps changes to session ids and resyncs on every (re)connect', () => {
    const c = fakeClient()
    const h = { onSessionChanged: vi.fn(), onStatus: vi.fn(), onResync: vi.fn() }
    const unsub = subscribeToExam(c, 'exam-1', h)
    c.ch.statusCb('SUBSCRIBED')
    c.ch.bindings.find(b => b.filter.table === 'risk_scores').cb({ new: { exam_session_id: 'es9' } })
    expect(h.onSessionChanged).toHaveBeenCalledWith('es9', 'risk_scores', expect.anything())
    c.ch.statusCb('CHANNEL_ERROR', new Error('socket closed'))
    expect(h.onStatus).toHaveBeenLastCalledWith('reconnecting', 'socket closed')
    c.ch.statusCb('SUBSCRIBED')
    expect(h.onResync).toHaveBeenCalledTimes(2)
    unsub()
    expect(c.removeChannel).toHaveBeenCalledWith(c.ch)
  })
})

describe('createSessionReloader', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces bursts per session', () => {
    const reload = vi.fn()
    const r = createSessionReloader(reload, { delayMs: 250 })
    r.schedule('a'); r.schedule('a'); r.schedule('b'); r.schedule('a')
    vi.advanceTimersByTime(250)
    expect(reload.mock.calls.map(c => c[0]).sort()).toEqual(['a', 'b'])
  })
})
