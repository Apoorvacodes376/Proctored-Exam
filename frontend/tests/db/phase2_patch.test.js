// Regression test for phase2_patch_rls_recursion.sql: the original phase 2
// policies on exams ↔ exam_assignments recurse; the patch must remove the
// recursion without widening access.

import { describe, it, expect, beforeAll } from 'vitest'
import { createDb, runAs } from './supabase'

const F1 = '00000000-0000-0000-0000-0000000000f1'
const F2 = '00000000-0000-0000-0000-0000000000f2'
const S1 = '00000000-0000-0000-0000-0000000000a1'

const faculty1 = { sub: F1, email: 'f1@uni.test' }
const faculty2 = { sub: F2, email: 'f2@uni.test' }
const student  = { sub: S1, email: 's1@uni.test' }

const BASE = ['phase1_setup.sql', 'phase2_faculty_management.sql', 'phase3_student_exam.sql']

describe('phase 2 RLS recursion', () => {
  it('reproduces the original bug without the patch', async () => {
    const db = await createDb(BASE)
    await expect(runAs(db, faculty1, 'select * from public.exams')).rejects.toThrow(/infinite recursion/)
  })

  describe('with phase2_patch_rls_recursion.sql', () => {
    let db, examA, examB

    beforeAll(async () => {
      db = await createDb([...BASE, 'phase2_patch_rls_recursion.sql', 'phase2_patch_rls_recursion.sql'])
      for (const [id, email] of [[F1, 'f1@uni.test'], [F2, 'f2@uni.test'], [S1, 's1@uni.test']]) {
        await db.query('insert into auth.users (id, email) values ($1, $2)', [id, email])
      }
      const ex = async f => (await db.query(
        `insert into public.exams (faculty_id, title, subject, exam_date, start_time, duration_mins)
         values ($1, 'T', 'S', current_date, '09:00', 30) returning id`, [f])).rows[0].id
      examA = await ex(F1)
      examB = await ex(F1)
      const st = (await db.query(`insert into public.students (faculty_id, name, email, student_id)
                                  values ($1, 's', 's1@uni.test', 'S1') returning id`, [F1])).rows[0].id
      await db.query('insert into public.exam_assignments (exam_id, student_id) values ($1, $2)', [examA, st])
    })

    it('faculty see only their own exams', async () => {
      expect((await runAs(db, faculty1, 'select id from public.exams')).rows).toHaveLength(2)
      expect((await runAs(db, faculty2, 'select id from public.exams')).rows).toHaveLength(0)
    })

    it('students see only exams they are assigned to', async () => {
      const { rows } = await runAs(db, student, 'select id from public.exams')
      expect(rows.map(r => r.id)).toEqual([examA])
    })

    it('students can load their assignment with the embedded exam (ExamRoom query)', async () => {
      const { rows } = await runAs(db, student,
        'select ea.id, e.title from public.exam_assignments ea join public.exams e on e.id = ea.exam_id')
      expect(rows).toHaveLength(1)
    })

    it('only the owning faculty can manage assignments', async () => {
      expect((await runAs(db, faculty1, 'select id from public.exam_assignments')).rows).toHaveLength(1)
      expect((await runAs(db, faculty2, 'select id from public.exam_assignments')).rows).toHaveLength(0)
      await expect(runAs(db, faculty2,
        `insert into public.exam_assignments (exam_id, student_id) select $1, id from public.students limit 1`, [examB]))
        .resolves.toMatchObject({ affectedRows: 0 })   // faculty2 cannot even see the student row
      await expect(runAs(db, faculty2,
        `insert into public.exam_assignments (exam_id, student_id) values ($1, gen_random_uuid())`, [examB]))
        .rejects.toThrow(/row-level security/)
    })

    it('exam_sessions and questions are queryable again', async () => {
      await expect(runAs(db, student,  'select * from public.exam_sessions')).resolves.toBeTruthy()
      await expect(runAs(db, faculty1, 'select * from public.questions')).resolves.toBeTruthy()
    })
  })
})
