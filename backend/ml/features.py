"""
Feature extraction for the OPTIONAL learned risk model.

Features come from the same stored breakdown the rule-based score uses
(risk_scores.breakdown), so a learned model sees exactly what faculty see.
Identity-verification features are kept in a separate group and are only
included when explicitly requested.
"""

CATEGORIES = ["face_absence", "multiple_people", "objects", "tab_switching", "audio", "media"]
PER_CATEGORY = ["counted", "duplicates", "duration_s", "effective"]
IDENTITY = ["identity_failed", "identity_inconclusive", "identity_manual_review"]

# Faculty outcomes that can serve as labels. "inconclusive" is excluded:
# it is not evidence either way.
LABELS = {"no_misconduct": 0, "misconduct": 1}


def feature_names(include_identity=False):
    names = [f"{c}.{f}" for c in CATEGORIES for f in PER_CATEGORY]
    return names + (IDENTITY if include_identity else [])


def extract(breakdown, include_identity=False):
    """Breakdown dict → list of floats (missing values → 0)."""
    cats = (breakdown or {}).get("categories", {}) or {}
    row = []
    for c in CATEGORIES:
        cat = cats.get(c, {}) or {}
        for f in PER_CATEGORY:
            row.append(float(cat.get(f) or 0))
    if include_identity:
        ident = (breakdown or {}).get("identity", {}) or {}
        row += [
            float(ident.get("failed") or 0),
            float(ident.get("inconclusive") or 0),
            1.0 if ident.get("manual_review_requested") else 0.0,
        ]
    return row


def build_dataset(records, include_identity=False, with_thresholds=False):
    """
    records: iterable of {"outcome": str, "breakdown": dict, "score": number,
                          "review_threshold": number (optional, default 40)}
    Returns (X, y, rule_scores, skipped[, review_thresholds]) using only
    definite outcomes.
    """
    X, y, rule, thresholds, skipped = [], [], [], [], 0
    for r in records:
        label = LABELS.get(r.get("outcome"))
        if label is None or not r.get("breakdown"):
            skipped += 1
            continue
        X.append(extract(r["breakdown"], include_identity))
        y.append(label)
        rule.append(float(r.get("score") or 0))
        thresholds.append(float(r.get("review_threshold") or 40))
    if with_thresholds:
        return X, y, rule, skipped, thresholds
    return X, y, rule, skipped
