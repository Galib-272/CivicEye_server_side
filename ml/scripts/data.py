"""Loading the preprocessed dataset (manifests/processed.csv) for training and evaluation."""

from __future__ import annotations

import random

import numpy as np
import pandas as pd
import torch
from PIL import Image
from tqdm import tqdm

from common import MANIFESTS, ML, PROCESSED, SEED
from transforms import CLASSES, TASKS

MODELS = ML / "models"
PREDICTIONS = PROCESSED / "predictions"
#: Damage photos from the detection dataset: always "damage". Same phones and roads as its
#: no-damage photos, so they show whether a model looks at the road or at the photo source.
SHORTCUT = "damage_detection_only"


def seed_everything(seed: int = SEED) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def manifest() -> pd.DataFrame:
    return pd.read_csv(MANIFESTS / "processed.csv")


def task_rows(frame: pd.DataFrame, task: str, split: str) -> pd.DataFrame:
    """Rows for one step, with its label in a "target" column.

    presence: is there damage? All four classes plus the detection dataset's damage photos.
    The detection dataset has damaged and clear roads from the same phones and places, so the
    source of a photo says nothing about the answer and the model has to look at the road.
    type: which damage? Pothole, crack and asphalt damage photos from RSD-BD."""
    in_split = frame["split"] == split
    if task == "presence":
        rows = frame[in_split & frame["class"].isin([*CLASSES, SHORTCUT])].copy()
        rows["target"] = np.where(rows["class"] == "no_damage", "no_damage", "damage")
    else:
        rows = frame[in_split & frame["class"].isin(TASKS["type"])].copy()
        rows["target"] = rows["class"]
    return rows.reset_index(drop=True)


def prediction_rows(frame: pd.DataFrame) -> pd.DataFrame:
    """Every validation and test image the classifiers are scored on, plus the detection
    dataset's damage photos for the shortcut test."""
    keep = frame["split"].isin(["validation", "test"]) & frame["class"].isin([*CLASSES, SHORTCUT])
    return frame[keep].reset_index(drop=True)


def preload(frame: pd.DataFrame, short_side: int, desc: str) -> list[Image.Image]:
    """Images in memory, shorter side reduced to short_side (the training crops are smaller)."""
    images = []
    for path in tqdm(frame["processed_path"], desc=desc, unit="img", leave=False):
        img = Image.open(PROCESSED / path).convert("RGB")
        scale = short_side / min(img.size)
        if scale < 1:
            img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
        images.append(img)
    return images
