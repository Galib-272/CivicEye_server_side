"""Feature selection step of the hybrid model, in its own module so a saved model can be
loaded by any script (a class defined in a script that is run directly cannot be)."""

from __future__ import annotations

import hashlib

import numpy as np
from sklearn.base import BaseEstimator
from sklearn.feature_selection import SelectorMixin, mutual_info_classif

from common import SEED

_MI_CACHE: dict[str, np.ndarray] = {}


class MutualInfoSelect(SelectorMixin, BaseEstimator):
    """Keeps the k features with the highest mutual information with the class.
    Scores are cached per training fold, so trying several k values costs one computation."""

    def __init__(self, k: int | str = "all"):
        self.k = k

    def fit(self, X, y):
        key = hashlib.sha1(np.ascontiguousarray(X).tobytes() + np.asarray(y).tobytes()).hexdigest()
        if key not in _MI_CACHE:
            _MI_CACHE[key] = mutual_info_classif(X, y, random_state=SEED)
        self.scores_ = _MI_CACHE[key]
        self.n_features_in_ = X.shape[1]
        return self

    def _get_support_mask(self):
        mask = np.ones(self.n_features_in_, dtype=bool)
        if self.k != "all" and self.k < self.n_features_in_:
            mask[:] = False
            mask[np.argsort(self.scores_)[::-1][: self.k]] = True
        return mask
