-- ============================================================
-- Phase 9 — Liveness (challenge-response) in identity verification
--
-- The browser now asks the student to complete a short random
-- challenge (blink / turn head left / turn head right) before the face
-- match is accepted. This migration lets each identity_verifications
-- row record that:
--   * liveness_result    'passed' | 'failed' | 'not_run'
--                        (NULL on rows written before this migration)
--   * liveness_challenge the steps asked, e.g. 'blink,turn_left,blink'
--   * result 'liveness_failed' — the challenge was not completed. This
--     is an indicator for faculty review, not a verdict: it is counted
--     in the existing identity flag (attempts with no pass), never in
--     the behavioural risk score.
-- Safe to re-run.
-- ============================================================

alter table public.identity_verifications
  add column if not exists liveness_result    text,
  add column if not exists liveness_challenge text;

alter table public.identity_verifications
  drop constraint if exists identity_verifications_liveness_result_check;
alter table public.identity_verifications
  add constraint identity_verifications_liveness_result_check
  check (liveness_result is null or liveness_result in ('passed', 'failed', 'not_run'));

alter table public.identity_verifications
  drop constraint if exists identity_verifications_result_check;
alter table public.identity_verifications
  add constraint identity_verifications_result_check
  check (result in (
    'passed', 'failed', 'inconclusive', 'liveness_failed',
    'manual_review_requested', 'no_reference_face', 'no_reference_photo'));
