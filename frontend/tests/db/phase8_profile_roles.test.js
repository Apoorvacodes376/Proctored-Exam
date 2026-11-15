// Regression test for phase8_patch_profile_roles.sql.
// phase7 let users make themselves faculty: the signup trigger trusted
// user_metadata.role, and the profiles policies trusted the (user-editable)
// user_metadata claim in the JWT. The patch must close both.

import { describe, it, expect } from 'vitest'
import { createDb, runAs } from './supabase'

const BASE = [
  'phase1_setup.sql',
  'phase2_faculty_management.sql',
  'phase2_patch_rls_recursion.sql',
  'phase3_student_exam.sql',
  'phase4_ai_monitoring.sql',
  'phase4_patch_monitoring.sql',
  'phase5_review_risk_scoring.sql',
  'phase5_patch_monitoring_review.sql',
  'phase6_research_evaluation.sql',
  'phase6_patch_integrity_evaluation.sql',
  'phase7_fix_auth_rls.sql',
]

const STUDENT = '00000000-0000-0000-0000-0000000000a1'
const OTHER   = '00000000-0000-0000-0000-0000000000a2'
const FACULTY = '00000000-0000-0000-0000-0000000000f1'

async function signUp(db, id, email, meta) {
  await db.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)',
    [id, email, JSON.stringify(meta)])
}

// A student whose token claims faculty in user_metadata (the user can set that themselves).
const forgedClaims = { sub: STUDENT, email: 'a1@uni.test', user_metadata: { role: 'faculty' } }

describe('profile roles before the patch (phase7)', () => {
  it('lets a signup choose faculty, and a student forge the claim', async () => {
    const db = await createDb(BASE)
    await signUp(db, STUDENT, 'a1@uni.test', { username: 'a1', role: 'faculty' })
    await signUp(db, OTHER, 'a2@uni.test', { username: 'a2' })
    expect((await db.query('select role from public.profiles where id = $1', [STUDENT])).rows[0].role).toBe('faculty')

    // forged user_metadata claim reads every profile
    await db.query("update public.profiles set role = 'student' where id = $1", [STUDENT])
    const { rows } = await runAs(db, forgedClaims, 'select id from public.profiles')
    expect(rows.length).toBe(2)
  })
})

describe('profile roles with phase8_patch_profile_roles.sql', () => {
  async function patched() {
    const db = await createDb([...BASE, 'phase8_patch_profile_roles.sql', 'phase8_patch_profile_roles.sql'])
    await signUp(db, STUDENT, 'a1@uni.test', { username: 'a1', role: 'faculty' })   // asks for faculty
    await signUp(db, OTHER, 'a2@uni.test', { username: 'a2' })
    await signUp(db, FACULTY, 'f1@uni.test', { username: 'f1' })
    await db.query("update public.profiles set role = 'faculty' where id = $1", [FACULTY])  // admin promotion
    return db
  }

  it('makes every signup a student, whatever the form sent', async () => {
    const db = await patched()
    const { rows } = await db.query('select role from public.profiles where id = $1', [STUDENT])
    expect(rows[0].role).toBe('student')
    const u = (await db.query('select raw_user_meta_data, raw_app_meta_data from auth.users where id = $1', [STUDENT])).rows[0]
    expect(u.raw_user_meta_data.role).toBeUndefined()
    expect(u.raw_app_meta_data.role).toBe('student')
  })

  it('ignores a forged user_metadata role claim', async () => {
    const db = await patched()
    const { rows } = await runAs(db, forgedClaims, 'select id from public.profiles')
    expect(rows.map(r => r.id)).toEqual([STUDENT])        // only their own row
  })

  it('does not let a student change their own role', async () => {
    const db = await patched()
    await expect(runAs(db, forgedClaims, "update public.profiles set role = 'faculty' where id = $1", [STUDENT]))
      .rejects.toThrow()
    const { rows } = await db.query('select role from public.profiles where id = $1', [STUDENT])
    expect(rows[0].role).toBe('student')
  })

  it('only allows a self-inserted profile row to be a student', async () => {
    const db = await patched()
    const NEW = '00000000-0000-0000-0000-0000000000b1'
    await db.query('insert into auth.users (id, email) values ($1, $2)', [NEW, 'b1@uni.test'])
    await db.query('delete from public.profiles where id = $1', [NEW])   // simulate the trigger race
    const claims = { sub: NEW, email: 'b1@uni.test' }
    await expect(runAs(db, claims,
      "insert into public.profiles (id, username, email, role) values ($1, 'b1', 'b1@uni.test', 'faculty')", [NEW])).rejects.toThrow()
    await runAs(db, claims,
      "insert into public.profiles (id, username, email, role) values ($1, 'b1', 'b1@uni.test', 'student')", [NEW])
  })

  it('still lets a real faculty member (role stored in profiles) read all profiles', async () => {
    const db = await patched()
    const { rows } = await runAs(db, { sub: FACULTY, email: 'f1@uni.test' }, 'select id from public.profiles')
    expect(rows.length).toBe(3)
  })
})
