// Server-renders every Evaluation page section from a report built by the
// real report code, with no data and with a populated (hand-written,
// non-experimental) fixture, to catch runtime errors and any NaN /
// undefined leaking into what faculty see.

import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../../lib/supabase', () => ({ supabase: {} }))

const {
  DataSummary, AlertsSection, DistributionSection, DetectorSection, IdentitySection,
  RiskSection, ModelSection, LatencySection, ReviewerSection, GroundTruthSection,
} = await import('../EvaluationPage')
const { buildReport } = await import('../../../evaluation/report')

const T0 = Date.parse('2026-03-01T09:00:00Z')
const at = s => new Date(T0 + s * 1000).toISOString()
const NOW = T0 + 2 * 3600 * 1000

const EMPTY = { sessions: [], events: [], riskScores: [], riskEval: [], trials: [], intervals: [], identity: [], performance: [], modelCards: [] }

const student = { name: 'Test Student', student_id: 'S1' }
const FULL = {
  sessions: [
    { id: 's1', exam_id: 'e1', exam_title: 'Algebra', status: 'submitted', started_at: at(0), submitted_at: at(3600), student },
    { id: 's2', exam_id: 'e1', exam_title: 'Algebra', status: 'submitted', started_at: at(0), submitted_at: at(3600), student },
  ],
  events: [
    { id: 'v1', exam_session_id: 's1', event_type: 'phone_detected', occurred_at: at(100), created_at: at(101), metadata: { class_name: 'cell phone' }, review: { decision: 'confirmed' } },
    { id: 'v2', exam_session_id: 's1', event_type: 'tab_switch', occurred_at: at(500), created_at: at(500), review: { decision: 'dismissed' } },
    { id: 'v3', exam_session_id: 's2', event_type: 'face_not_detected', occurred_at: at(50), ended_at: at(80), created_at: at(52) },
  ],
  riskScores: [{ exam_session_id: 's1', score: 55, review_threshold: 40 }, { exam_session_id: 's2', score: 12, review_threshold: 40 }],
  riskEval: [
    { exam_session_id: 's1', live_score: 55, score_without_reviews: 60, review_threshold: 40, outcome: 'misconduct' },
    { exam_session_id: 's2', live_score: 12, score_without_reviews: 12, review_threshold: 40, outcome: 'no_misconduct' },
  ],
  trials: [{ id: 't1', exam_session_id: 's1', data_kind: 'scripted', annotated_categories: ['object', 'tab_switch'] }],
  intervals: [{ trial_id: 't1', category: 'object', starts_at: at(98), ends_at: at(120), label: 'cell phone' }],
  identity: [
    { id: 'i1', exam_id: 'e1', result: 'passed', distance: 0.4, attempted_at: at(0), student, ground_truth: { is_genuine: true, data_kind: 'scripted' } },
    { id: 'i2', exam_id: 'e1', result: 'failed', distance: 0.8, attempted_at: at(0), student, ground_truth: { is_genuine: false, data_kind: 'scripted' } },
  ],
  performance: [{ exam_session_id: 's1', module: 'objects', samples: 50, mean_ms: 80, p50_ms: 75, p95_ms: 120, max_ms: 150 }],
  modelCards: [{ id: 'm1', exam_id: null, imported_at: at(0), card: {
    model: 'logistic', labelled_sessions: 60, status: 'experimental — not used for live scoring',
    cross_validation: { folds: 5, model: { roc_auc: { mean: 0.7, std: 0.05 } }, rule_based_score: { roc_auc: { mean: 0.68, std: 0.04 } },
      pooled_out_of_fold: { 'model_at_0.5': { f1: 0.6 }, rule_at_review_threshold: { f1: 0.55 } } } } }],
}

function renderAll(report, data) {
  return renderToString(
    <MemoryRouter>
      <DataSummary report={report} />
      <AlertsSection alerts={report.alerts} />
      <DistributionSection distribution={report.distribution} />
      <DetectorSection rows={report.detectors} />
      <IdentitySection rows={report.identity} />
      <RiskSection risk={report.risk} />
      <ModelSection models={report.models} examId={null} onChange={() => {}} />
      <LatencySection rows={report.latency} logging={report.loggingDelay} />
      <ReviewerSection reviewers={report.reviewers} />
      <GroundTruthSection data={data} onChange={() => {}} />
    </MemoryRouter>,
  )
}

describe('Evaluation page sections', () => {
  it('render "not measured" everywhere when there is no data', () => {
    const html = renderAll(buildReport(EMPTY, { now: NOW }), EMPTY)
    expect(html).toContain('Not measured')
    expect(html).toContain('No sessions have been annotated with ground truth')
    expect(html).not.toMatch(/NaN|undefined|Infinity/)
    expect(html).not.toMatch(/\b0\.0%/)   // no fabricated zero rates
  })

  it('render real figures with their provenance when data exists', () => {
    const html = renderAll(buildReport(FULL, { now: NOW }), FULL)
    expect(html).not.toMatch(/NaN|undefined|Infinity/)
    for (const s of ['Measured', 'Descriptive counts', 'Phone detected', 'False acceptance rate', 'ROC-AUC',
      'Prohibited objects', 'logistic', 'Object detection (per frame)', 'Scripted trial', 'Edit', 'Annotate']) {
      expect(html, s).toContain(s)
    }
  })
})
