"""Model 2: hybrid classifier on CNN embeddings plus handcrafted features, for one step of the
two-step classifier (presence: damage or no damage; type: pothole, crack or asphalt damage).

Features (from preprocess.py): 960 MobileNetV3 ImageNet embedding values and 386 handcrafted
colour, texture, shape and quality values. Pipeline, fitted on the training split only:

    z-score  ->  feature selection (mutual information)  ->  PCA  ->  SVM or gradient boosting

Every setting is tried with 5-fold cross-validation on the training split. The folds are
grouped like the split, so photos of one place never sit on both sides of a fold. The best
setting by mean macro F1 is refitted on the whole training split. The test split is not used.

Writes ml/models/hybrid-<task>.joblib, ml/reports/hybrid-<task>-cv.csv and validation/test
probabilities to ml/data/processed/predictions/hybrid-<task>.npz.

Usage:  python ml/scripts/train_hybrid.py --task presence|type [--smoke]
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.base import clone
from sklearn.calibration import CalibratedClassifierCV
from sklearn.decomposition import PCA
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import f1_score
from sklearn.model_selection import ParameterGrid, StratifiedGroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC
from tqdm import tqdm

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import PROCESSED, REPORTS, SEED  # noqa: E402
from data import MODELS, PREDICTIONS, manifest, prediction_rows, seed_everything, task_rows  # noqa: E402
from selection import MutualInfoSelect  # noqa: E402
from transforms import TASKS  # noqa: E402

def pipeline(classifier) -> Pipeline:
    return Pipeline(
        [
            ("scale", StandardScaler()),
            ("select", MutualInfoSelect()),
            ("pca", PCA(random_state=SEED)),
            ("classify", classifier),
        ]
    )


SEARCH = {
    "svm": (
        # Probabilities from cross-validated calibration (needed for soft voting).
        CalibratedClassifierCV(SVC(kernel="rbf", class_weight="balanced", random_state=SEED), ensemble=False),
        {
            "select__k": [200, 500, "all"],
            "pca__n_components": [0.90, 0.95],
            "classify__estimator__C": [1, 5, 20],
        },
    ),
    "gradient_boosting": (
        HistGradientBoostingClassifier(class_weight="balanced", max_iter=300, early_stopping=False, random_state=SEED),
        {
            "select__k": [200, "all"],
            "pca": [PCA(n_components=0.95, random_state=SEED), "passthrough"],
            "classify__learning_rate": [0.1],
            "classify__max_leaf_nodes": [15],
        },
    ),
}


def describe(params: dict) -> str:
    return ", ".join(f"{k.split('__')[-1]}={'PCA(0.95)' if isinstance(v, PCA) else v}" for k, v in params.items())


def main(task: str, smoke: bool) -> None:
    seed_everything()
    frame = manifest()
    stored = np.load(PROCESSED / "features.npz", allow_pickle=True)  # our own file
    position = {image_id: i for i, image_id in enumerate(stored["image_id"])}
    features = np.hstack([stored["cnn"], stored["handcrafted"]]).astype(np.float64)

    classes = TASKS[task]
    train = task_rows(frame, task, "train")
    if smoke:
        train = train.groupby("target").head(30).reset_index(drop=True)
    X = features[[position[i] for i in train["image_id"]]]
    y = train["target"].map({c: i for i, c in enumerate(classes)}).to_numpy()
    folds = list(StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=SEED).split(X, y, train["group"]))

    candidates = []
    for family, (classifier, grid) in SEARCH.items():
        settings = list(ParameterGrid(grid))[: 2 if smoke else None]
        candidates += [(family, classifier, params) for params in settings]

    results = []
    started = time.time()
    bar = tqdm(total=len(candidates) * len(folds), desc=f"Hybrid {task} cross-validation", unit="fit")
    for family, classifier, params in candidates:
        scores = []
        for train_index, test_index in folds:
            model = pipeline(clone(classifier)).set_params(**params)
            model.fit(X[train_index], y[train_index])
            scores.append(f1_score(y[test_index], model.predict(X[test_index]), average="macro"))
            bar.update()
        results.append({"family": family, "settings": describe(params), "mean_macro_f1": np.mean(scores), "std": np.std(scores), "params": params, "classifier": classifier})
        best = max(results, key=lambda r: r["mean_macro_f1"])
        bar.set_postfix(best=f"{best['family']} {best['mean_macro_f1']:.3f}")
    bar.close()

    best = max(results, key=lambda r: r["mean_macro_f1"])
    tqdm.write(f"Hybrid {task}: best {best['family']} ({best['settings']}), CV macro F1 {best['mean_macro_f1']:.4f} ± {best['std']:.4f} ({(time.time() - started) / 60:.1f} min)")

    model = pipeline(clone(best["classifier"])).set_params(**best["params"])
    model.fit(X, y)
    MODELS.mkdir(exist_ok=True)
    joblib.dump({"pipeline": model, "classes": classes, "family": best["family"], "settings": best["settings"]}, MODELS / f"hybrid-{task}.joblib", compress=3)
    table = pd.DataFrame(results).drop(columns=["params", "classifier"]).sort_values("mean_macro_f1", ascending=False)
    table.round(4).to_csv(REPORTS / f"hybrid-{task}-cv.csv", index=False)

    rows = prediction_rows(frame)
    probabilities = model.predict_proba(features[[position[i] for i in rows["image_id"]]])
    PREDICTIONS.mkdir(parents=True, exist_ok=True)
    np.savez(PREDICTIONS / f"hybrid-{task}.npz", image_id=rows["image_id"].to_numpy(dtype=str), probabilities=probabilities)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", choices=list(TASKS), required=True)
    parser.add_argument("--smoke", action="store_true", help="tiny run to check the script works")
    args = parser.parse_args()
    main(args.task, args.smoke)
