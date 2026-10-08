"""python eval_sop/tests/test_analyze_auroc.py - fast AUROC equals sklearn (incl. heavy ties)."""
import os, sys
import numpy as np
from sklearn.metrics import roc_auc_score
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from analyze import auroc
rng = np.random.default_rng(0)
for _ in range(500):
    n = int(rng.integers(5, 120)); y = rng.integers(0, 2, n)
    if 0 < y.sum() < n:
        s = rng.choice([0.0, 0.3, 0.6, 0.8, 0.9], n) if _ % 2 else rng.random(n)
        assert abs(auroc(y, s) - roc_auc_score(y, s)) < 1e-12
assert np.isnan(auroc(np.ones(5), np.arange(5)))
print("auroc tests: all passed")
