// phase9_patch_liveness.sql: liveness fields on identity attempts.

import { describe, it, expect, beforeAll } from 'vitest'
import { createFixture, ALL_MIGRATIONS } from './fixtures'

const MIGRATIONS = [...ALL_MIGRATIONS, 'phase9_patch_liveness.sql']
let fx
beforeAll(async () => { fx = await createFixture(MIGRATIONS) })

const insert = (who, cols, vals) =>
  fx.as(who, `insert into public.identity_verifications (exam_id, student_id, ${cols}) values ($1, $2, ${vals})`,
    [fx.exam, fx[who].student])

describe('liveness columns on identity_verifications', () => {
  it('old-style rows (no liveness) are still accepted', async () => {
    await insert('alice', 'result', `'passed'`)
    const { rows } = await fx.db.query('select liveness_result, liveness_challenge from public.identity_verifications where student_id = $1', [fx.alice.student])
    expect(rows[0]).toEqual({ liveness_result: null, liveness_challenge: null })
  })

  it('records the challenge and a failed liveness attempt', async () => {
    await insert('bob', 'result, liveness_result, liveness_challenge', `'liveness_failed', 'failed', 'blink,turn_left,blink'`)
    const { rows } = await fx.db.query('select result, liveness_result, liveness_challenge from public.identity_verifications where student_id = $1', [fx.bob.student])
    expect(rows[0]).toEqual({ result: 'liveness_failed', liveness_result: 'failed', liveness_challenge: 'blink,turn_left,blink' })
  })

  it('rejects unknown values', async () => {
    await expect(insert('bob', 'result, liveness_result', `'passed', 'maybe'`)).rejects.toThrow(/check|violates/)
    await expect(insert('bob', 'result', `'spoofed'`)).rejects.toThrow(/check|violates/)
  })

  it('a liveness failure does not add to the behavioural score but flags identity', async () => {
    await fx.as('alice', `insert into public.identity_verifications (exam_id, student_id, result, liveness_result) values ($1, $2, 'liveness_failed', 'failed')`, [fx.exam, fx.alice.student])
    const b = await fx.breakdown('alice')
    expect(b.score).toBe(0)
    expect(b.identity.attempts).toBeGreaterThan(0)
  })

  it('is idempotent', async () => {
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync(new URL('../../../supabase/migrations/phase9_patch_liveness.sql', import.meta.url), 'utf8')
    await fx.db.exec(sql)
    await fx.db.exec(sql)
  })
})
