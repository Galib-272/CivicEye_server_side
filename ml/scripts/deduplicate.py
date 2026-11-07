"""Keeps one copy of each photo (PRD §18.4: duplicate images).

Uses the manifests written by inspect_datasets.py. Photos are grouped when their pixels are
identical (SHA-256), or when they have the same label, perceptual hashes within 4 bits and
nearly identical pixels (correlation >= 0.95): the same photo re-saved or resized. From each group one photo is kept: the one with phone camera metadata if any, then the
largest. Nothing else is changed: no resizing, renaming or relabelling.

The kept photos are copied to ml/data/deduplicated/<dataset>/ in the original folder layout,
and ml/manifests/<dataset>-deduplication.csv lists every file with its group and decision.
The original download in ml/data/extracted is never modified.

Usage:  python ml/scripts/deduplicate.py
"""

from __future__ import annotations

import shutil
from pathlib import Path

import imagehash
import numpy as np
import pandas as pd
from PIL import Image

ML = Path(__file__).resolve().parent.parent
EXTRACTED = ML / "data" / "extracted"
OUTPUT = ML / "data" / "deduplicated"
MANIFESTS = ML / "manifests"
NEAR_DUPLICATE_DISTANCE = 4
#: Pixel correlation (64x64 grayscale) a near match must also reach. Perceptual hashes alone
#: confuse different photos of smooth roads; real re-saves and resizes score 0.98 or more.
MIN_PIXEL_CORRELATION = 0.95


def _pixels(path: Path) -> np.ndarray:
    with Image.open(path) as img:
        gray = np.asarray(img.convert("L").resize((64, 64)), dtype=np.float32)
    return ((gray - gray.mean()) / (gray.std() + 1e-6)).ravel()


def same_pixels(a: Path, b: Path, cache: dict[Path, np.ndarray]) -> bool:
    va = cache.setdefault(a, _pixels(a))
    vb = cache.setdefault(b, _pixels(b))
    return float(np.dot(va, vb) / va.size) >= MIN_PIXEL_CORRELATION


def groups_for(frame: pd.DataFrame) -> list[int]:
    """Group number per row: exact copies and near copies share a group."""
    hashes = [imagehash.hex_to_hash(value) for value in frame["phash"]]
    parent = list(range(len(frame)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    first_by_sha: dict[str, int] = {}
    for i, sha in enumerate(frame["pixel_sha256"]):
        if sha in first_by_sha:
            parent[find(i)] = find(first_by_sha[sha])
        else:
            first_by_sha[sha] = i
    labels = frame["label"].tolist()
    paths = [EXTRACTED / value for value in frame["path"]]
    cache: dict[Path, np.ndarray] = {}
    for i in range(len(hashes)):
        for j in range(i + 1, len(hashes)):
            # A near copy needs the same label, a close perceptual hash and nearly identical
            # pixels; reviewed false matches (different smooth roads) fail the pixel test.
            if (
                labels[i] == labels[j]
                and hashes[i] - hashes[j] <= NEAR_DUPLICATE_DISTANCE
                and same_pixels(paths[i], paths[j], cache)
            ):
                parent[find(i)] = find(j)
    roots = [find(i) for i in range(len(frame))]
    numbering = {root: n for n, root in enumerate(dict.fromkeys(roots), start=1)}
    return [numbering[root] for root in roots]


def deduplicate(name: str, folder: str) -> pd.DataFrame:
    frame = pd.read_csv(MANIFESTS / f"{name}.csv")
    frame["camera"] = frame["camera"].fillna("")
    frame["group"] = groups_for(frame)
    frame["pixels"] = frame["width"] * frame["height"]
    # Prefer a photo with camera metadata, then the largest, then the first file name.
    ranked = frame.sort_values(
        ["group", "camera", "pixels", "path"],
        ascending=[True, False, False, True],
        key=lambda column: column.ne("") if column.name == "camera" else column,
    )
    keep = ranked.groupby("group").head(1).index
    frame["decision"] = "removed (copy)"
    frame.loc[keep, "decision"] = "kept"

    labels_by_group = frame.groupby("group")["label"].nunique()
    conflicting = labels_by_group[labels_by_group > 1]
    if not conflicting.empty:
        print(f"{name}: {len(conflicting)} groups have different labels; review them by hand.")

    target = OUTPUT / folder
    if target.exists():
        shutil.rmtree(target)
    for _, row in frame[frame["decision"] == "kept"].iterrows():
        source = EXTRACTED / row["path"]
        destination = OUTPUT / row["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        if name == "detection":
            # Detection photos keep their box labels alongside them.
            label = Path(str(source).replace("/images/", "/labels/")).with_suffix(".txt")
            label_target = Path(str(destination).replace("/images/", "/labels/")).with_suffix(".txt")
            label_target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(label, label_target)

    frame[["path", "label", "group", "decision", "camera", "width", "height"]].to_csv(
        MANIFESTS / f"{name}-deduplication.csv", index=False
    )
    kept = frame[frame["decision"] == "kept"]
    print(
        f"{name}: {len(frame)} files -> {len(kept)} kept, {len(frame) - len(kept)} removed. "
        f"Kept by label: {kept['label'].value_counts().to_dict()}"
    )
    return frame


if __name__ == "__main__":
    deduplicate("detection", "Bangladesh-Road-Damage-Dataset")
    deduplicate("rsd-bd", "rsd-bd")
