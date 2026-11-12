"""
Code-path tests for the optional learned model. The records built here are
throwaway test fixtures for exercising the code — they are not training
data and say nothing about real-world accuracy.

Run from backend/:  python -m unittest ml.test_train_risk_model
"""

import random
import unittest

from ml.features import build_dataset, extract, feature_names
from ml.train_risk_model import NotEnoughData, check_data, evaluate, threshold_metrics, train


def fixture_breakdown(tab, phone, failed=0):
    return {
        "categories": {
            "tab_switching": {"counted": tab, "duplicates": 0, "duration_s": tab * 10, "effective": tab * 1.3},
            "objects": {"counted": phone, "duplicates": 0, "duration_s": 0, "effective": phone * 0.9},
        },
        "identity": {"failed": failed, "inconclusive": 0, "manual_review_requested": False},
    }


class FeatureTests(unittest.TestCase):
    def test_extract_orders_features_and_fills_missing(self):
        row = extract(fixture_breakdown(3, 1))
        names = feature_names()
        self.assertEqual(len(row), len(names))
        self.assertEqual(row[names.index("tab_switching.counted")], 3)
        self.assertEqual(row[names.index("face_absence.effective")], 0)

    def test_identity_features_only_when_requested(self):
        self.assertEqual(len(extract(fixture_breakdown(0, 0, failed=2), include_identity=True)), len(feature_names(True)))
        self.assertNotIn("identity_failed", feature_names(False))

    def test_only_definite_outcomes_are_labels(self):
        recs = [
            {"outcome": "misconduct", "breakdown": fixture_breakdown(1, 1), "score": 50},
            {"outcome": "no_misconduct", "breakdown": fixture_breakdown(0, 0), "score": 0},
            {"outcome": "inconclusive", "breakdown": fixture_breakdown(1, 0), "score": 20},
            {"outcome": None, "breakdown": fixture_breakdown(1, 0), "score": 20},
            {"outcome": "misconduct", "breakdown": None, "score": 20},
        ]
        X, y, rule, skipped = build_dataset(recs)
        self.assertEqual(y, [1, 0])
        self.assertEqual(skipped, 3)


class ThresholdMetricTests(unittest.TestCase):
    def test_by_hand(self):
        r = threshold_metrics([1, 1, 1, 0, 0], [1, 1, 0, 1, 0])
        self.assertEqual((r["tp"], r["fp"], r["tn"], r["fn"]), (2, 1, 1, 1))
        self.assertEqual((r["precision"], r["recall"], r["f1"]), (0.667, 0.667, 0.667))

    def test_undefined_is_none_not_zero(self):
        r = threshold_metrics([0, 0], [0, 0])
        self.assertIsNone(r["precision"])
        self.assertIsNone(r["recall"])
        self.assertIsNone(r["f1"])


class GuardTests(unittest.TestCase):
    def test_refuses_small_datasets(self):
        with self.assertRaises(NotEnoughData):
            check_data([1] * 5 + [0] * 5)

    def test_refuses_unbalanced_datasets(self):
        with self.assertRaises(NotEnoughData) as ctx:
            check_data([1] * 3 + [0] * 100)
        self.assertIn("rule-based", str(ctx.exception))

    def test_refuses_when_everything_is_inconclusive(self):
        recs = [{"outcome": "inconclusive", "breakdown": fixture_breakdown(1, 1), "score": 30}] * 100
        with self.assertRaises(NotEnoughData):
            train(recs)


class PipelineTests(unittest.TestCase):
    """Exercises CV and training on a random fixture — checks the plumbing only."""

    def setUp(self):
        rng = random.Random(0)
        self.records = []
        for i in range(60):
            label = i % 2
            tab, phone = rng.randint(0, 3) + 2 * label, rng.randint(0, 1) + label
            self.records.append({"outcome": ["no_misconduct", "misconduct"][label],
                                 "breakdown": fixture_breakdown(tab, phone), "score": 10 * tab + 20 * phone})

    def test_cross_validation_reports_model_and_rule_baseline(self):
        X, y, rule, _ = build_dataset(self.records)
        m = evaluate(X, y, rule, "logistic", folds=5)
        self.assertEqual(m["folds"], 5)
        for k in ("model", "rule_based_score"):
            self.assertTrue(0 <= m[k]["roc_auc"]["mean"] <= 1)

    def test_pooled_out_of_fold_confusion_matrices_cover_every_session(self):
        X, y, rule, _ = build_dataset(self.records)
        m = evaluate(X, y, rule, "logistic", folds=5, rule_thresholds=[40.0] * len(y))
        for k in ("model_at_0.5", "rule_at_review_threshold"):
            cm = m["pooled_out_of_fold"][k]
            self.assertEqual(cm["tp"] + cm["fp"] + cm["tn"] + cm["fn"], len(y))

    def test_train_produces_a_model_card_marked_experimental(self):
        model, card = train(self.records, "gradient_boosting")
        self.assertEqual(card["labelled_sessions"], 60)
        self.assertIn("not used for live scoring", card["status"])
        self.assertTrue(any("not evidence" in c for c in card["caveats"]))
        self.assertIn("dismissals ignored", card["score_source"])
        self.assertEqual(len(model.predict([extract(fixture_breakdown(1, 0))])), 1)


if __name__ == "__main__":
    unittest.main()
