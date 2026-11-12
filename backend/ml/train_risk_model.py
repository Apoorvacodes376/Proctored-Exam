"""
OPTIONAL: train a learned risk model from faculty-labelled sessions.

This is an offline research tool. It does NOT change the live risk score,
which stays rule-based and transparent. It will refuse to train until
there is enough real, faculty-labelled data, and it reports only
cross-validated metrics measured on that data, next to the rule-based
score's performance on the same labels.

Labels come from session_reviews.outcome recorded by faculty
('misconduct' = 1, 'no_misconduct' = 0; 'inconclusive' and unlabelled
sessions are skipped). Faculty outcomes can themselves be influenced by
the risk score they saw, so treat any result as indicative, not ground
truth.

Features and the rule-based baseline come from risk_evaluation_data()
(Phase 6): the breakdown/score recomputed with faculty dismissals
IGNORED. Using the live score instead would leak reviewers' own event
decisions into both the features and the baseline.

The model card can be imported on the faculty Evaluation page to compare
with the rule-based score.

Usage:
  python -m ml.train_risk_model --from-supabase [--exam EXAM_ID] [--out models/]
  python -m ml.train_risk_model --from-json labelled.json
Options:
  --model logistic|gradient_boosting|xgboost   (default: logistic)
  --include-identity                           add identity features
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

from .features import build_dataset, feature_names

MIN_TOTAL = 40
MIN_PER_CLASS = 10


class NotEnoughData(Exception):
    pass


def check_data(y):
    pos, neg = sum(y), len(y) - sum(y)
    if len(y) < MIN_TOTAL or pos < MIN_PER_CLASS or neg < MIN_PER_CLASS:
        raise NotEnoughData(
            f"Not enough labelled sessions to train or evaluate a model: {len(y)} labelled "
            f"({pos} misconduct, {neg} no misconduct). Need at least {MIN_TOTAL} in total and "
            f"{MIN_PER_CLASS} of each outcome. Keep using the rule-based score."
        )
    return pos, neg


def make_model(kind, random_state=0):
    if kind == "logistic":
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import make_pipeline
        from sklearn.preprocessing import StandardScaler
        return make_pipeline(StandardScaler(), LogisticRegression(class_weight="balanced", max_iter=1000))
    if kind == "gradient_boosting":
        from sklearn.ensemble import GradientBoostingClassifier
        return GradientBoostingClassifier(random_state=random_state)
    if kind == "xgboost":
        try:
            from xgboost import XGBClassifier
        except ImportError as e:  # optional dependency
            raise SystemExit("xgboost is not installed: pip install xgboost") from e
        return XGBClassifier(n_estimators=200, max_depth=3, learning_rate=0.1, eval_metric="logloss")
    raise ValueError(f"unknown model {kind}")


def threshold_metrics(y, flagged):
    """Confusion matrix and precision/recall/F1 for 0/1 labels and 0/1 decisions."""
    pairs = list(zip(y, flagged))
    tp = sum(1 for a, b in pairs if a and b)
    fp = sum(1 for a, b in pairs if not a and b)
    tn = sum(1 for a, b in pairs if not a and not b)
    fn = sum(1 for a, b in pairs if a and not b)
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1 = 2 * precision * recall / (precision + recall) if precision and recall else None
    r = lambda v: None if v is None else round(v, 3)
    return {"tp": tp, "fp": fp, "tn": tn, "fn": fn, "precision": r(precision), "recall": r(recall), "f1": r(f1)}


def evaluate(X, y, rule_scores, kind="logistic", folds=5, random_state=0, rule_thresholds=None):
    """
    Stratified k-fold CV. Returns per-fold mean±std ROC-AUC / average
    precision for the model and the rule baseline, plus pooled
    out-of-fold confusion matrices: the model at probability 0.5 and the
    rule score at each session's review threshold (default 40).
    """
    import numpy as np
    from sklearn.metrics import roc_auc_score, average_precision_score
    from sklearn.model_selection import StratifiedKFold

    X, y, rule = np.asarray(X, float), np.asarray(y, int), np.asarray(rule_scores, float)
    thr = np.asarray(rule_thresholds if rule_thresholds is not None else [40.0] * len(y), float)
    folds = min(folds, int(min(y.sum(), len(y) - y.sum())))
    skf = StratifiedKFold(n_splits=folds, shuffle=True, random_state=random_state)
    m_auc, m_ap, r_auc, r_ap = [], [], [], []
    oof = np.zeros(len(y))
    for train, test in skf.split(X, y):
        model = make_model(kind, random_state)
        model.fit(X[train], y[train])
        p = model.predict_proba(X[test])[:, 1]
        oof[test] = p
        m_auc.append(roc_auc_score(y[test], p)); m_ap.append(average_precision_score(y[test], p))
        r_auc.append(roc_auc_score(y[test], rule[test])); r_ap.append(average_precision_score(y[test], rule[test]))

    summary = lambda v: {"mean": round(float(np.mean(v)), 3), "std": round(float(np.std(v)), 3)}
    return {
        "folds": folds,
        "model":    {"roc_auc": summary(m_auc), "average_precision": summary(m_ap)},
        "rule_based_score": {"roc_auc": summary(r_auc), "average_precision": summary(r_ap)},
        "pooled_out_of_fold": {
            "model_at_0.5": threshold_metrics(y.tolist(), (oof >= 0.5).astype(int).tolist()),
            "rule_at_review_threshold": threshold_metrics(y.tolist(), (rule >= thr).astype(int).tolist()),
        },
        "positive_rate": round(float(y.mean()), 3),
    }


def train(records, kind="logistic", include_identity=False):
    X, y, rule, skipped, thresholds = build_dataset(records, include_identity, with_thresholds=True)
    pos, neg = check_data(y)
    metrics = evaluate(X, y, rule, kind, rule_thresholds=thresholds)
    model = make_model(kind)
    model.fit(X, y)
    card = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "model": kind,
        "features": feature_names(include_identity),
        "labelled_sessions": len(y), "misconduct": pos, "no_misconduct": neg, "skipped": skipped,
        "cross_validation": metrics,
        "label_source": "session_reviews.outcome (faculty decisions)",
        "score_source": "risk_evaluation_data(): breakdown and score with faculty dismissals ignored",
        "status": "experimental — not used for live scoring",
        "caveats": [
            "Labels are faculty decisions, which may have been influenced by the rule-based score.",
            "Metrics are cross-validated on this dataset only and may not generalise to other exams, cohorts or devices.",
            "A model output is not evidence of misconduct.",
        ],
    }
    return model, card


def fetch_from_supabase(exam_id=None):
    """Labelled sessions via risk_evaluation_data() (service role; run from backend/)."""
    from app.database import supabase
    if exam_id:
        exam_ids = [exam_id]
    else:
        reviews = supabase.table("session_reviews").select("exam_id").not_.is_("outcome", "null").execute().data or []
        exam_ids = sorted({r["exam_id"] for r in reviews})
    records = []
    for eid in exam_ids:
        for r in supabase.rpc("risk_evaluation_data", {"p_exam_id": eid}).execute().data or []:
            records.append({
                "outcome": r["outcome"],
                "breakdown": r["breakdown_without_reviews"],
                "score": r["score_without_reviews"],
                "review_threshold": r["review_threshold"],
            })
    return records


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--from-supabase", action="store_true")
    src.add_argument("--from-json")
    ap.add_argument("--exam")
    ap.add_argument("--model", default="logistic", choices=["logistic", "gradient_boosting", "xgboost"])
    ap.add_argument("--include-identity", action="store_true")
    ap.add_argument("--out", default="models")
    args = ap.parse_args(argv)

    records = fetch_from_supabase(args.exam) if args.from_supabase else json.load(open(args.from_json))
    try:
        model, card = train(records, args.model, args.include_identity)
    except NotEnoughData as e:
        print(e, file=sys.stderr)
        return 2

    import joblib
    os.makedirs(args.out, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    joblib.dump(model, os.path.join(args.out, f"risk_model_{stamp}.joblib"))
    with open(os.path.join(args.out, f"risk_model_{stamp}.card.json"), "w") as f:
        json.dump(card, f, indent=2)
    print(json.dumps(card["cross_validation"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
