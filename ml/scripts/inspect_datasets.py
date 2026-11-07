"""Data quality inspection for CivicEye's datasets (PRD §18.4).

Builds a manifest (one row per image) with Pandas and checks, without changing anything:
- unreadable or corrupted files and missing or invalid labels,
- exact duplicates (SHA-256 of the pixels) and near duplicates (perceptual hash),
  including duplicates that cross the train/validation/test split (data leakage),
- outliers: unusual sizes, very dark or bright images, very blurry images,
- for detection labels: box counts, sizes, and boxes outside the image,
- camera metadata (EXIF), as evidence that photos are original captures.

Writes ml/manifests/<dataset>.csv and ml/reports/<dataset>-quality.json.

Usage:  python ml/scripts/inspect_datasets.py detection|rsd-bd
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import imagehash
import numpy as np
import pandas as pd
from PIL import ExifTags, Image, UnidentifiedImageError
from skimage.filters import laplace

ML = Path(__file__).resolve().parent.parent
DATA = ML / "data" / "extracted"
MANIFESTS = ML / "manifests"
REPORTS = ML / "reports"

#: Perceptual-hash distance at or below which two images count as near duplicates.
NEAR_DUPLICATE_DISTANCE = 4


def image_stats(path: Path) -> dict:
    """Pixel-level facts about one image, or the reason it cannot be read."""
    try:
        with Image.open(path) as img:
            exif = img.getexif()
            camera = " ".join(
                str(exif.get(tag)).strip()
                for tag in (ExifTags.Base.Make, ExifTags.Base.Model)
                if exif.get(tag)
            )
            img.load()
            rgb = img.convert("RGB")
    except (UnidentifiedImageError, OSError) as error:
        return {"readable": False, "error": str(error)[:200]}
    gray = np.asarray(rgb.convert("L"), dtype=np.float32) / 255.0
    return {
        "readable": True,
        "error": "",
        "width": rgb.width,
        "height": rgb.height,
        "mode": img.mode,
        "pixel_sha256": hashlib.sha256(rgb.tobytes()).hexdigest(),
        "phash": str(imagehash.phash(rgb)),
        "brightness": float(gray.mean()),
        # Variance of the Laplacian: low values mean few edges, i.e. a blurry image.
        "sharpness": float(laplace(gray).var() * 1e4),
        "camera": camera,
    }


def detection_rows() -> list[dict]:
    """Bangladesh Road Damage Detection Dataset: YOLO labels, one class."""
    root = DATA / "Bangladesh-Road-Damage-Dataset"
    rows = []
    for split, folder in (("train", "train"), ("validation", "valid"), ("test", "test")):
        for image in sorted((root / folder / "images").iterdir()):
            label = root / folder / "labels" / f"{image.stem}.txt"
            boxes, problems = [], []
            if not label.exists():
                problems.append("missing label file")
            else:
                for line_number, line in enumerate(label.read_text().splitlines(), 1):
                    parts = line.split()
                    if not parts:
                        continue
                    if len(parts) != 5:
                        problems.append(f"line {line_number}: {len(parts)} values")
                        continue
                    cls, cx, cy, w, h = parts[0], *map(float, parts[1:])
                    if cls != "0":
                        problems.append(f"line {line_number}: class {cls}")
                    if w <= 0 or h <= 0 or cx - w / 2 < -0.01 or cx + w / 2 > 1.01 or cy - h / 2 < -0.01 or cy + h / 2 > 1.01:
                        problems.append(f"line {line_number}: box outside the image")
                    boxes.append(w * h)
            source = image.name.split("_jpg")[0]
            rows.append(
                {
                    "dataset": "bangladesh-road-damage",
                    "path": str(image.relative_to(DATA)),
                    "source_name": source,
                    "label": "normal" if source.startswith("normal") else "damage",
                    "original_split": split,
                    "boxes": len(boxes),
                    "smallest_box_area": min(boxes) if boxes else None,
                    "largest_box_area": max(boxes) if boxes else None,
                    "label_problems": "; ".join(problems),
                }
            )
    return rows


def rsd_bd_rows() -> list[dict]:
    """RSD-BD: one class per image, from the folder name."""
    root = DATA / "rsd-bd"
    rows = []
    for image in sorted(p for p in root.rglob("*") if p.is_file() and not p.name.startswith(".")):
        if image.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp", ".bmp"}:
            continue
        rows.append(
            {
                "dataset": "rsd-bd",
                "path": str(image.relative_to(DATA)),
                "source_name": image.stem,
                "label": image.parent.name,
                "original_split": "",
                "boxes": None,
                "label_problems": "",
            }
        )
    return rows


def near_duplicate_groups(frame: pd.DataFrame) -> list[list[int]]:
    """Groups of row indexes whose perceptual hashes are within the distance threshold."""
    hashes = [imagehash.hex_to_hash(value) for value in frame["phash"]]
    parent = list(range(len(hashes)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(hashes)):
        for j in range(i + 1, len(hashes)):
            if hashes[i] - hashes[j] <= NEAR_DUPLICATE_DISTANCE:
                parent[find(i)] = find(j)
    groups: dict[int, list[int]] = {}
    for i in range(len(hashes)):
        groups.setdefault(find(i), []).append(i)
    return [members for members in groups.values() if len(members) > 1]


def main(name: str) -> None:
    rows = detection_rows() if name == "detection" else rsd_bd_rows()
    frame = pd.DataFrame(rows)
    stats = pd.DataFrame([image_stats(DATA / path) for path in frame["path"]])
    frame = pd.concat([frame, stats], axis=1)
    readable = frame[frame["readable"]].reset_index(drop=True)

    exact = readable[readable.duplicated("pixel_sha256", keep=False)]
    groups = near_duplicate_groups(readable)
    near = [
        {
            "images": readable.loc[members, "path"].tolist(),
            "labels": sorted(set(readable.loc[members, "label"])),
            "splits": sorted(set(readable.loc[members, "original_split"])),
        }
        for members in groups
    ]
    q = readable[["brightness", "sharpness"]].quantile([0.01, 0.99])
    report = {
        "dataset": name,
        "images": int(len(frame)),
        "unreadable": frame.loc[~frame["readable"], ["path", "error"]].to_dict("records"),
        "label_problems": frame.loc[frame["label_problems"] != "", ["path", "label_problems"]].to_dict("records"),
        "by_label": frame["label"].value_counts().to_dict(),
        "by_label_and_split": {
            f"{split}/{label}": int(count)
            for (split, label), count in frame.groupby(["original_split", "label"]).size().items()
        }
        if name == "detection"
        else {},
        "sizes": {
            f"{w}x{h}": int(count)
            for (w, h), count in readable.groupby(["width", "height"]).size().sort_values(ascending=False).head(10).items()
        },
        "exact_duplicate_images": int(len(exact)),
        "exact_duplicate_groups": int(exact["pixel_sha256"].nunique()),
        "near_duplicate_groups": len(near),
        "near_duplicate_groups_with_different_labels": sum(len(g["labels"]) > 1 for g in near),
        "near_duplicate_groups_across_splits": sum(len(g["splits"]) > 1 for g in near),
        "near_duplicate_examples": near[:15],
        "brightness": {"min": readable["brightness"].min(), "p1": q.loc[0.01, "brightness"], "median": readable["brightness"].median(), "p99": q.loc[0.99, "brightness"], "max": readable["brightness"].max()},
        "sharpness": {"min": readable["sharpness"].min(), "p1": q.loc[0.01, "sharpness"], "median": readable["sharpness"].median(), "max": readable["sharpness"].max()},
        "very_dark": readable.loc[readable["brightness"] < 0.12, "path"].tolist(),
        "very_bright": readable.loc[readable["brightness"] > 0.9, "path"].tolist(),
        "very_blurry": readable.loc[readable["sharpness"] < q.loc[0.01, "sharpness"], "path"].tolist(),
        "with_camera_exif": int((readable["camera"] != "").sum()),
        "cameras": readable.loc[readable["camera"] != "", "camera"].value_counts().head(10).to_dict(),
    }
    if name == "detection":
        damage = frame[frame["label"] == "damage"]
        report["boxes"] = {
            "total": int(damage["boxes"].sum()),
            "damage_images_without_boxes": int((damage["boxes"] == 0).sum()),
            "normal_images_with_boxes": int(((frame["label"] == "normal") & (frame["boxes"] > 0)).sum()),
            "per_damage_image": damage["boxes"].describe().round(2).to_dict(),
            "tiny_boxes_under_0.1_percent": int((damage["smallest_box_area"] < 0.001).sum()),
        }

    MANIFESTS.mkdir(exist_ok=True)
    REPORTS.mkdir(exist_ok=True)
    frame.drop(columns=["readable"]).to_csv(MANIFESTS / f"{name}.csv", index=False)
    (REPORTS / f"{name}-quality.json").write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps({k: v for k, v in report.items() if k not in {"near_duplicate_examples", "very_blurry"}}, indent=2, default=str))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "detection")
