"""Scores the two-step classifier and writes the training report.

Step 1 (presence): damage or no damage. Step 2 (type): pothole, crack or asphalt damage.
Each step has a CNN, a hybrid model and a soft-voting ensemble of the two (ensemble weight
chosen on validation). The final answer combines the steps:

    P(no damage) = P1(no damage)
    P(pothole)   = P1(damage) x P2(pothole)        (same for crack and asphalt damage)

- The model CivicEye will use is chosen by validation macro F1 of the combined answer.
  The test split only reports how each model does on photos it has never influenced.
- Metrics: accuracy, balanced accuracy, macro and weighted precision/recall/F1, per-class
  precision/recall/F1, top-2 accuracy, one-vs-rest ROC AUC, confusion matrix, and a 95%
  bootstrap interval for test macro F1 (resampling photo groups).
- Source check: on the detection dataset alone (damaged and clear roads from the same phones),
  is damage still found? This is what the first, single-step design failed.
- Speed: time per photo on this Mac's CPU (the server will not have a GPU).

Writes ml/reports/training.json, training.md and confusion-<model>.png.

Usage:  python ml/scripts/evaluate.py
"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime
from pathlib import Path

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
from PIL import Image  # noqa: E402
from sklearn.metrics import (  # noqa: E402
    accuracy_score,
    balanced_accuracy_score,
    confusion_matrix,
    f1_score,
    precision_recall_fscore_support,
    roc_auc_score,
)
from tqdm import tqdm  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from common import PROCESSED, REPORTS, SEED, Embedder  # noqa: E402
from data import MODELS, PREDICTIONS, SHORTCUT, manifest, prediction_rows  # noqa: E402
from preprocess import handcrafted  # noqa: E402
from transforms import CLASSES, TASKS, eval_transform, eval_view  # noqa: E402

KINDS = ("cnn", "hybrid", "ensemble")
NAMES = {"cnn": "CNN (MobileNetV3)", "hybrid": "Hybrid (features + classical)", "ensemble": "Ensemble (soft voting)"}
LABELS = {"pothole": "Pothole", "crack": "Crack", "asphalt_damage": "Asphalt damage", "no_damage": "No damage", "damage": "Damage"}


def load_probabilities(name: str, ids: list[str]) -> np.ndarray:
    stored = np.load(PREDICTIONS / f"{name}.npz")
    position = {image_id: i for i, image_id in enumerate(stored["image_id"])}
    return stored["probabilities"][[position[i] for i in ids]]


def scores(y: np.ndarray, p: np.ndarray, classes: list[str], groups: np.ndarray | None = None) -> dict:
    predicted = p.argmax(1)
    labels = range(len(classes))
    precision, recall, f1, support = precision_recall_fscore_support(y, predicted, labels=labels, zero_division=0)
    result = {
        "accuracy": accuracy_score(y, predicted),
        "balanced_accuracy": balanced_accuracy_score(y, predicted),
        "macro_precision": float(precision.mean()),
        "macro_recall": float(recall.mean()),
        "macro_f1": f1_score(y, predicted, average="macro"),
        "weighted_f1": f1_score(y, predicted, average="weighted"),
        "roc_auc": roc_auc_score(y, p[:, 1]) if len(classes) == 2 else roc_auc_score(y, p, multi_class="ovr", average="macro"),
        "per_class": {
            c: {"precision": float(precision[k]), "recall": float(recall[k]), "f1": float(f1[k]), "photos": int(support[k])}
            for k, c in enumerate(classes)
        },
        "confusion_matrix": confusion_matrix(y, predicted, labels=labels).tolist(),
    }
    if len(classes) > 2:
        result["top2_accuracy"] = float(np.mean([y[i] in np.argsort(p[i])[-2:] for i in range(len(y))]))
    if groups is not None:
        rng = np.random.default_rng(SEED)
        unique = np.unique(groups)
        members = {g: np.where(groups == g)[0] for g in unique}
        samples = []
        for _ in range(1000):
            index = np.concatenate([members[g] for g in rng.choice(unique, len(unique))])
            samples.append(f1_score(y[index], predicted[index], average="macro"))
        result["macro_f1_95_interval"] = [float(np.percentile(samples, 2.5)), float(np.percentile(samples, 97.5))]
    return result


def combine(presence: np.ndarray, kind: np.ndarray) -> np.ndarray:
    """Four-class probabilities from the two steps (columns in CLASSES order)."""
    damage = presence[:, TASKS["presence"].index("damage")]
    return np.column_stack([damage[:, None] * kind, 1 - damage])


def plot_confusion(matrix, classes: list[str], title: str, path: Path) -> None:
    matrix = np.asarray(matrix)
    n = len(classes)
    fig, ax = plt.subplots(figsize=(1.3 * n + 2, 1.15 * n + 1.8), dpi=120)
    ax.imshow(matrix, cmap="Blues")
    labels = [LABELS[c].replace(" ", "\n") for c in classes]
    ax.set_xticks(range(n), labels)
    ax.set_yticks(range(n), labels)
    ax.set_xlabel("Predicted")
    ax.set_ylabel("Actual")
    ax.set_title(title, fontsize=10)
    for i in range(n):
        for j in range(n):
            ax.text(j, i, matrix[i, j], ha="center", va="center", color="white" if matrix[i, j] > matrix.max() / 2 else "black")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def latency(frame) -> dict:
    """Milliseconds per photo on the CPU, one photo at a time, median of 50 photos.
    The hybrid steps share one feature extraction."""
    from train_cnn import build_model

    torch.set_num_threads(4)
    rows = frame.sample(50, random_state=SEED)
    photos = [Image.open(PROCESSED / p).convert("RGB") for p in rows["processed_path"]]
    cnns, hybrids = {}, {}
    for task, classes in TASKS.items():
        model = build_model(len(classes))
        model.load_state_dict(torch.load(MODELS / f"cnn-{task}.pt", map_location="cpu")["state_dict"])
        cnns[task] = model.eval()
        hybrids[task] = joblib.load(MODELS / f"hybrid-{task}.joblib")["pipeline"]
    transform = eval_transform()
    original_device = common.device
    common.device = lambda: torch.device("cpu")
    embedder = Embedder()
    cnn_times, hybrid_times = [], []
    with torch.no_grad():
        for img in tqdm(photos, desc="Timing on CPU", unit="photo", leave=False):
            start = time.perf_counter()
            x = transform(img).unsqueeze(0)
            for model in cnns.values():
                torch.softmax(model(x), 1)
            cnn_times.append(time.perf_counter() - start)
            start = time.perf_counter()
            view = eval_view(img)
            features = np.hstack([embedder([view])[0], handcrafted(view)[0]])[None].astype(np.float64)
            for pipeline in hybrids.values():
                pipeline.predict_proba(features)
            hybrid_times.append(time.perf_counter() - start)
    common.device = original_device
    cnn_ms, hybrid_ms = 1000 * np.median(cnn_times), 1000 * np.median(hybrid_times)
    return {"cnn_ms": float(cnn_ms), "hybrid_ms": float(hybrid_ms), "ensemble_ms": float(cnn_ms + hybrid_ms)}


def main() -> None:
    frame = manifest()
    rows = prediction_rows(frame)
    ids = rows["image_id"].tolist()
    split = rows["split"].to_numpy()
    groups = rows["group"].to_numpy()

    # Probabilities per step and model kind, for every validation and test photo.
    probabilities, ensemble_weights, steps = {}, {}, {}
    for task, classes in TASKS.items():
        target = np.where(rows["class"] == "no_damage", "no_damage", "damage") if task == "presence" else rows["class"].to_numpy()
        eligible = rows["class"].isin([*CLASSES, SHORTCUT]).to_numpy() if task == "presence" else rows["class"].isin(classes).to_numpy()
        y = np.array([classes.index(t) if t in classes else -1 for t in target])
        p = {kind: load_probabilities(f"{kind}-{task}", ids) for kind in ("cnn", "hybrid")}
        val = eligible & (split == "validation")
        weight = max(
            np.round(np.arange(0, 1.01, 0.1), 1),
            key=lambda w: f1_score(y[val], (w * p["cnn"][val] + (1 - w) * p["hybrid"][val]).argmax(1), average="macro"),
        )
        p["ensemble"] = weight * p["cnn"] + (1 - weight) * p["hybrid"]
        probabilities[task], ensemble_weights[task] = p, float(weight)
        test = eligible & (split == "test")
        steps[task] = {}
        for kind in KINDS:
            steps[task][kind] = {
                "validation": scores(y[val], p[kind][val], classes),
                "test": scores(y[test], p[kind][test], classes, groups[test]),
            }
        if task == "presence":
            # Detection dataset only: damaged and clear roads from the same phones and places.
            same_source = test & rows["dataset"].eq("bangladesh-road-damage").to_numpy()
            rsd = test & rows["dataset"].eq("rsd-bd").to_numpy()
            for kind in KINDS:
                predicted = p[kind].argmax(1)
                damage = TASKS["presence"].index("damage")
                steps[task][kind]["source_check"] = {
                    "detection_dataset": scores(y[same_source], p[kind][same_source], classes),
                    "detection_damage_called_no_damage": int(((rows["class"] == SHORTCUT).to_numpy() & test & (predicted != damage)).sum()),
                    "detection_damage_photos": int(((rows["class"] == SHORTCUT).to_numpy() & test).sum()),
                    "rsd_bd_damage_recall": float((predicted[rsd] == damage).mean()),
                }

    # The combined four-class answer, on the same photos as the first design's report.
    y4 = np.array([CLASSES.index(c) if c in CLASSES else -1 for c in rows["class"]])
    four = rows["class"].isin(CLASSES).to_numpy()
    combined = {}
    for kind in KINDS:
        p4 = combine(probabilities["presence"][kind], probabilities["type"][kind])
        val, test = four & (split == "validation"), four & (split == "test")
        combined[kind] = {
            "validation": scores(y4[val], p4[val], CLASSES),
            "test": scores(y4[test], p4[test], CLASSES, groups[test]),
        }
        plot_confusion(combined[kind]["test"]["confusion_matrix"], CLASSES, f"{NAMES[kind]}, two-step - test set", REPORTS / f"confusion-{kind}.png")

    chosen = max(KINDS, key=lambda k: combined[k]["validation"]["macro_f1"])
    speed = latency(frame[frame["class"].isin(CLASSES)])
    detector = json.loads((REPORTS / "detector.json").read_text())
    first = json.loads((REPORTS / "v1-single-step" / "training.json").read_text())
    report = {
        "created": datetime.now().isoformat(timespec="seconds"),
        "design": "two-step: presence (damage / no damage), then type (pothole / crack / asphalt damage)",
        "chosen_model": chosen,
        "chosen_by": "highest validation macro F1 of the combined four-class answer",
        "ensemble_cnn_weight": ensemble_weights,
        "cnn_best_epoch": {t: torch.load(MODELS / f"cnn-{t}.pt", map_location="cpu")["best_epoch"] for t in TASKS},
        "hybrid": {t: {k: joblib.load(MODELS / f"hybrid-{t}.joblib")[k] for k in ("family", "settings")} for t in TASKS},
        "steps": steps,
        "combined": combined,
        "first_design_for_comparison": {
            kind: {"test_macro_f1": first["results"][kind]["test"]["macro_f1"], "detection_damage_called_no_damage": first["results"][kind]["shortcut_test"]["called_no_damage"]}
            for kind in KINDS
        },
        "cpu_ms_per_photo": speed,
        "detector": {k: detector[k] for k in ("threshold_chosen_on_validation", "validation", "test", "photos", "boxes")},
    }
    (REPORTS / "training.json").write_text(json.dumps(report, indent=2, default=float) + "\n")
    write_markdown(report)
    print(open(REPORTS / "training.md").read())


def pct(value: float) -> str:
    return f"{100 * value:.1f}%"


def write_markdown(report: dict) -> None:
    chosen, combined, steps = report["chosen_model"], report["combined"], report["steps"]
    test_photos = sum(m["photos"] for m in combined[chosen]["test"]["per_class"].values())
    lines = [
        "# Training results",
        "",
        f"Generated by `scripts/evaluate.py` on {report['created']}. All numbers come from `training.json`.",
        "",
        "**Design: two steps.** Step 1 decides whether a photo shows damage; step 2 decides which kind",
        "(pothole, crack or asphalt damage). Step 1 learns from a dataset where damaged and clear roads come",
        "from the same phones and places, so it cannot tell them apart by the photo source. The first,",
        "single-step design failed that check and is kept in `v1-single-step/` for comparison.",
        "",
        f"**Chosen model: {NAMES[chosen]}** ({report['chosen_by']}). Test photos were never used for training or choosing.",
        "",
        "## Final answer (four classes) on the test set",
        "",
        f"{test_photos} photos the models never saw. Macro = every class counts equally.",
        "",
        "| Model | Accuracy | Macro precision | Macro recall | Macro F1 (95% interval) | Top-2 | ROC AUC | Validation macro F1 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for kind in KINDS:
        t, v = combined[kind]["test"], combined[kind]["validation"]
        low, high = t["macro_f1_95_interval"]
        lines.append(
            f"| {NAMES[kind]} | {pct(t['accuracy'])} | {pct(t['macro_precision'])} | {pct(t['macro_recall'])} | "
            f"{pct(t['macro_f1'])} ({pct(low)}-{pct(high)}) | {pct(t['top2_accuracy'])} | {t['roc_auc']:.3f} | {pct(v['macro_f1'])} |"
        )
    lines += ["", f"### Per class, {NAMES[chosen]}", "", "| Class | Precision | Recall | F1 | Photos |", "|---|---:|---:|---:|---:|"]
    for c, m in combined[chosen]["test"]["per_class"].items():
        lines.append(f"| {LABELS[c]} | {pct(m['precision'])} | {pct(m['recall'])} | {pct(m['f1'])} | {m['photos']} |")
    lines += ["", "Confusion matrices: `confusion-cnn.png`, `confusion-hybrid.png`, `confusion-ensemble.png`.", ""]

    lines += [
        "## Source check (what the first design failed)",
        "",
        "Test photos from the detection dataset only: damaged and clear roads from the same phones and places.",
        "",
        "| Model | Accuracy | Damage found (recall) | Clear roads called damage | Damage called no damage | First design: damage called no damage |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for kind in KINDS:
        s = steps["presence"][kind]["source_check"]
        d = s["detection_dataset"]
        clear = d["confusion_matrix"][1]
        first = report["first_design_for_comparison"][kind]["detection_damage_called_no_damage"]
        lines.append(
            f"| {NAMES[kind]} | {pct(d['accuracy'])} | {pct(d['per_class']['damage']['recall'])} | {clear[0]} of {sum(clear)} | "
            f"{s['detection_damage_called_no_damage']} of {s['detection_damage_photos']} | {first} of {s['detection_damage_photos']} |"
        )

    for task, title in (("presence", "Step 1: damage or no damage (test set)"), ("type", "Step 2: which damage (test set, damaged photos only)")):
        lines += ["", f"## {title}", "", "| Model | Accuracy | Macro precision | Macro recall | Macro F1 | ROC AUC |", "|---|---:|---:|---:|---:|---:|"]
        for kind in KINDS:
            t = steps[task][kind]["test"]
            lines.append(f"| {NAMES[kind]} | {pct(t['accuracy'])} | {pct(t['macro_precision'])} | {pct(t['macro_recall'])} | {pct(t['macro_f1'])} | {t['roc_auc']:.3f} |")

    speed, d = report["cpu_ms_per_photo"], report["detector"]
    lines += [
        "",
        "## Speed (CPU, one photo at a time, median, both steps)",
        "",
        f"CNN {speed['cnn_ms']:.0f} ms, hybrid {speed['hybrid_ms']:.0f} ms, ensemble {speed['ensemble_ms']:.0f} ms per photo.",
        "",
        "## Detector (SSDLite320-MobileNetV3, boxes around damage)",
        "",
        f"Score threshold {d['threshold_chosen_on_validation']} (chosen on validation).",
        "",
        "| Split | mAP@0.5 | mAP@0.5:0.95 | Box precision | Box recall | Photo accuracy | Photo precision | Photo recall | Photo F1 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for split in ("validation", "test"):
        m = d[split]
        p = m["photos"]
        lines.append(
            f"| {split} | {pct(m['map50'])} | {pct(m['map50_95'])} | {pct(m['box_precision'])} | {pct(m['box_recall'])} | "
            f"{pct(p['accuracy'])} | {pct(p['precision'])} | {pct(p['recall'])} | {pct(p['f1'])} |"
        )
    w = report["ensemble_cnn_weight"]
    lines += [
        "",
        "Photo columns: does the detector find damage in a photo that has damage, and stay quiet on clear roads.",
        "",
        "## Settings",
        "",
        f"- CNN best epochs: presence {report['cnn_best_epoch']['presence']}, type {report['cnn_best_epoch']['type']}; balanced sampler, label smoothing 0.1, AdamW, cosine schedule.",
        f"- Hybrid: presence {report['hybrid']['presence']['family']} ({report['hybrid']['presence']['settings']}); "
        f"type {report['hybrid']['type']['family']} ({report['hybrid']['type']['settings']}). All settings in `hybrid-<step>-cv.csv`.",
        f"- Ensemble weights (CNN share, chosen on validation): presence {w['presence']:.1f}, type {w['type']:.1f}.",
        "",
    ]
    (REPORTS / "training.md").write_text("\n".join(lines))


if __name__ == "__main__":
    main()
