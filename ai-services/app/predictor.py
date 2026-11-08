"""Loads CivicEye's trained road damage models and analyses one photo.

The models, their checksums and thresholds are described by ml/models/manifest.json. Every file
is checked against its SHA-256 before loading; a mismatch stops the service (PRD §19.5).
The image code (feature extraction, transforms, network shapes) is shared with training in
ml/scripts, so a photo is prepared exactly as during training.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import time
from pathlib import Path

os.environ.setdefault("CIVICEYE_DEVICE", "cpu")  # the server has no GPU; set before torch use

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "ml" / "scripts"))

import joblib  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
from PIL import Image, ImageOps  # noqa: E402
from skimage.filters import laplace  # noqa: E402
from torchvision.transforms import v2  # noqa: E402

import selection  # noqa: E402,F401  (the saved hybrid pipelines refer to this module)
from common import Embedder  # noqa: E402
from features import handcrafted  # noqa: E402
from networks import build_classifier, build_detector  # noqa: E402
from transforms import CLASSES, TASKS, eval_transform, eval_view  # noqa: E402

#: Photos are reduced to this longer side first, as during preprocessing.
MAX_SIDE = 1024
MAX_BOXES = 10


class ModelIntegrityError(RuntimeError):
    """A model file is missing or does not match the checksum in the manifest."""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class Predictor:
    def __init__(self, model_dir: Path, threads: int = 2) -> None:
        self.model_dir = model_dir
        self.manifest = json.loads((model_dir / "manifest.json").read_text())
        for key, entry in self.manifest["files"].items():
            path = model_dir / entry["file"]
            if not path.is_file():
                raise ModelIntegrityError(f"Model file missing: {entry['file']}")
            if sha256(path) != entry["sha256"]:
                raise ModelIntegrityError(f"Checksum mismatch for {entry['file']} ({key})")

        torch.set_num_threads(threads)
        files = {key: model_dir / entry["file"] for key, entry in self.manifest["files"].items()}
        self.embedder = Embedder(weights=files["embedder"])
        self.cnn, self.hybrid = {}, {}
        for task, classes in TASKS.items():
            model = build_classifier(len(classes), pretrained=False)
            model.load_state_dict(torch.load(files[f"cnn_{task}"], map_location="cpu")["state_dict"])
            self.cnn[task] = model.eval()
            self.hybrid[task] = joblib.load(files[f"hybrid_{task}"])["pipeline"]
        self.detector = build_detector()
        self.detector.load_state_dict(torch.load(files["detector"], map_location="cpu")["state_dict"])
        self.detector.eval()
        self.transform = eval_transform()
        self.to_tensor = v2.Compose([v2.ToImage(), v2.ToDtype(torch.float32, scale=True)])
        self.lock = threading.Lock()

    @property
    def version(self) -> str:
        return self.manifest["version"]

    def _step(self, task: str, x: torch.Tensor, features: np.ndarray) -> np.ndarray:
        cnn = torch.softmax(self.cnn[task](x), dim=1)[0].numpy()
        hybrid = self.hybrid[task].predict_proba(features)[0]
        chosen = self.manifest["chosen_model"]
        if chosen == "cnn":
            return cnn
        if chosen == "hybrid":
            return hybrid
        weight = self.manifest["ensemble_cnn_weight"][task]
        return weight * cnn + (1 - weight) * hybrid

    def analyze(self, image: Image.Image) -> dict:
        started = time.perf_counter()
        thresholds = self.manifest["thresholds"]
        img = ImageOps.exif_transpose(image).convert("RGB")
        img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)

        gray = np.asarray(img.convert("L"), dtype=np.float32) / 255.0
        brightness = float(gray.mean())
        sharpness = float(laplace(gray).var() * 1e4)
        warnings = []
        if brightness < thresholds["dark_below"]:
            warnings.append("too_dark")
        if sharpness < thresholds["blurry_below"]:
            warnings.append("blurry")

        with self.lock, torch.no_grad():
            view = eval_view(img)
            # As in evaluation: shorter side to 256 px (Lanczos) before the centre crop.
            scale = 256 / min(img.size)
            small = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS) if scale < 1 else img
            x = self.transform(small).unsqueeze(0)
            features = np.hstack([self.embedder([view])[0], handcrafted(view)[0]])[None].astype(np.float64)
            presence = self._step("presence", x, features)
            kind = self._step("type", x, features)
            damage = float(presence[TASKS["presence"].index("damage")])
            probabilities = np.append(damage * kind, 1 - damage)
            classified_ms = (time.perf_counter() - started) * 1000

            detections = self.detector([self.to_tensor(img)])[0]
        keep = detections["scores"] >= thresholds["detector_score"]
        boxes = detections["boxes"][keep][:MAX_BOXES].tolist()
        scores = detections["scores"][keep][:MAX_BOXES].tolist()

        top = int(np.argmax(probabilities))
        confidence = float(probabilities[top])
        return {
            "modelVersion": self.version,
            "label": CLASSES[top],
            "confidence": round(confidence, 4),
            "uncertain": confidence < thresholds["uncertain_below"],
            "probabilities": {c: round(float(p), 4) for c, p in zip(CLASSES, probabilities)},
            "damageProbability": round(damage, 4),
            "detections": [
                {
                    # Box corners as fractions of the photo's width and height (0-1), upright.
                    "box": [round(b[0] / img.width, 4), round(b[1] / img.height, 4), round(b[2] / img.width, 4), round(b[3] / img.height, 4)],
                    "score": round(s, 4),
                }
                for b, s in zip(boxes, scores)
            ],
            "quality": {"brightness": round(brightness, 4), "sharpness": round(sharpness, 2), "warnings": warnings},
            "timingsMs": {
                "classification": round(classified_ms, 1),
                "total": round((time.perf_counter() - started) * 1000, 1),
            },
        }
