"""Writes ml/models/manifest.json: the version, files, checksums, classes, thresholds,
datasets and test results of the trained models (PRD §19.4). The AI service refuses to start
when a file's SHA-256 does not match this manifest.

Also saves ml/models/embedder.pt (the ImageNet MobileNetV3 feature extractor the hybrid model
was trained on), so the AI service needs no download.

Usage:  python ml/scripts/make_manifest.py
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import date
from pathlib import Path

import pandas as pd
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import MANIFESTS, REPORTS, Embedder  # noqa: E402
from data import MODELS  # noqa: E402
from transforms import CLASSES, TASKS  # noqa: E402

VERSION = "road-damage-2026.11.08"
#: Below this top score a suggestion is labelled "uncertain" and left to the reviewer (PRD §17.5).
UNCERTAIN_BELOW = 0.6
#: Photos darker than this mean brightness (0-1) get a "too dark" warning.
DARK_BELOW = 0.12


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    embedder = MODELS / "embedder.pt"
    if not embedder.exists():
        torch.save(Embedder().net.cpu().state_dict(), embedder)

    training = json.loads((REPORTS / "training.json").read_text())
    detector = json.loads((REPORTS / "detector.json").read_text())
    processed = pd.read_csv(MANIFESTS / "processed.csv")
    blurry_below = float(processed["sharpness"].quantile(0.01))

    files = {
        "embedder": ("embedder.pt", "MobileNetV3-Large features, ImageNet weights (torchvision IMAGENET1K_V2)"),
        "cnn_presence": ("cnn-presence.pt", "MobileNetV3-Large fine-tuned: damage / no damage"),
        "cnn_type": ("cnn-type.pt", "MobileNetV3-Large fine-tuned: pothole / crack / asphalt damage"),
        "hybrid_presence": ("hybrid-presence.joblib", "z-score, mutual-information selection, PCA, SVM: damage / no damage"),
        "hybrid_type": ("hybrid-type.joblib", "z-score, mutual-information selection, PCA, SVM: damage type"),
        "detector": ("detector.pt", "SSDLite320-MobileNetV3-Large, 1 class (damage)"),
    }
    chosen = training["chosen_model"]
    combined = training["combined"][chosen]["test"]
    manifest = {
        "version": VERSION,
        "created": date.today().isoformat(),
        "task": "road_damage",
        "classes": CLASSES,
        "steps": TASKS,
        "chosen_model": chosen,
        "ensemble_cnn_weight": training["ensemble_cnn_weight"],
        "files": {key: {"file": name, "architecture": about, "sha256": sha256(MODELS / name)} for key, (name, about) in files.items()},
        "thresholds": {
            "uncertain_below": UNCERTAIN_BELOW,
            "detector_score": detector["threshold_chosen_on_validation"],
            "dark_below": DARK_BELOW,
            "blurry_below": round(blurry_below, 3),
        },
        "datasets": [
            {"name": "Bangladesh Road Damage Detection Dataset v1", "doi": "10.17632/ktnx66vtmc.1", "licence": "CC BY 4.0"},
            {"name": "RSD-BD v1", "doi": "10.17632/745n5wnt7v.1", "licence": "CC BY 4.0"},
        ],
        "training": {
            "manifest": "ml/manifests/processed.csv",
            "scripts": "ml/scripts/train_all.sh",
            "report": "ml/reports/training.md",
        },
        "evaluation_test_set": {
            "photos": sum(m["photos"] for m in combined["per_class"].values()),
            "accuracy": round(combined["accuracy"], 4),
            "macro_f1": round(combined["macro_f1"], 4),
            "macro_f1_95_interval": [round(v, 4) for v in combined["macro_f1_95_interval"]],
            "per_class_f1": {c: round(m["f1"], 4) for c, m in combined["per_class"].items()},
            "detector_map50": round(detector["test"]["map50"], 4),
        },
        "approval_state": "evaluated; not approved for production (see ml/ACCEPTANCE_CRITERIA.md)",
        "deployment_state": "development only",
    }
    (MODELS / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({k: manifest[k] for k in ("version", "thresholds", "evaluation_test_set")}, indent=2))


if __name__ == "__main__":
    main()
