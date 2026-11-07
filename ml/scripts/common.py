"""Paths and helpers shared by CivicEye's ML scripts."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps

ML = Path(__file__).resolve().parent.parent
DATA = ML / "data"
DEDUPLICATED = DATA / "deduplicated"
PROCESSED = DATA / "processed"
PRETRAINED = DATA / "pretrained"
MANIFESTS = ML / "manifests"
REPORTS = ML / "reports"
SEED = 42

# Pretrained weights live inside the project (ml/data/pretrained), not in ~/.cache.
os.environ.setdefault("TORCH_HOME", str(PRETRAINED))

#: ImageNet statistics the pretrained MobileNetV3 weights expect.
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


def device() -> torch.device:
    return torch.device("mps" if torch.backends.mps.is_available() else "cpu")


def open_rgb(path: Path) -> Image.Image:
    """Opens an image upright (EXIF orientation applied) as plain RGB."""
    with Image.open(path) as img:
        return ImageOps.exif_transpose(img).convert("RGB")


class Embedder:
    """MobileNetV3-Large (ImageNet) features: one L2-normalized 960-value vector per image."""

    def __init__(self) -> None:
        from torchvision.models import MobileNet_V3_Large_Weights, mobilenet_v3_large

        model = mobilenet_v3_large(weights=MobileNet_V3_Large_Weights.IMAGENET1K_V2)
        self.net = torch.nn.Sequential(model.features, model.avgpool, torch.nn.Flatten()).eval()
        self.net.to(device())
        self.mean = torch.tensor(IMAGENET_MEAN).view(1, 3, 1, 1)
        self.std = torch.tensor(IMAGENET_STD).view(1, 3, 1, 1)

    @torch.no_grad()
    def __call__(self, images: list[Image.Image], batch: int = 64) -> np.ndarray:
        out = []
        for start in range(0, len(images), batch):
            chunk = [np.asarray(im.resize((224, 224), Image.BILINEAR), dtype=np.float32) for im in images[start : start + batch]]
            x = torch.from_numpy(np.stack(chunk)).permute(0, 3, 1, 2) / 255.0
            x = ((x - self.mean) / self.std).to(device())
            features = self.net(x).cpu()
            out.append(torch.nn.functional.normalize(features, dim=1).numpy())
        return np.concatenate(out) if out else np.zeros((0, 960), dtype=np.float32)
