"""Preprocessing for CivicEye's road damage models (PRD §18.4-18.6, Phase 9).

Input: the de-duplicated datasets in ml/data/deduplicated (see deduplicate.py).
Output:
- ml/data/processed/images/...   cleaned images (ignored by git)
- ml/data/processed/labels/...   detection boxes adjusted to the cleaned images
- ml/data/processed/features.npz CNN embeddings and handcrafted features
- ml/manifests/processed.csv      one row per image: class, encoding, group, split, flags
- ml/reports/preprocessing.json   every number below, and preprocessing.md (readable summary)
- ml/reports/augmentation-examples.jpg

Steps, in order:
 1. Labels: map folder names to four classes (pothole, crack, asphalt_damage, no_damage);
    detection-only damage photos are kept for the detector.
 2. Cleaning: EXIF orientation applied, RGB, metadata stripped, black letterbox bars cropped
    (the detection dataset's normal photos have side bars and damage photos top/bottom bars,
    which a model could learn instead of the road), longer side capped at 1024 px, one JPEG
    quality for every file. Boxes are moved and clipped to match.
 3. Outliers: images under MIN_SHORT_SIDE px are dropped; unusual brightness, contrast,
    sharpness or shape is flagged (IQR rule) and kept, because real reports look like that too.
 4. Groups: photos of the same place stay together. Linked when taken within 30 s of each
    other, when their CNN embeddings are near identical, or when a close-up crop matches a
    region of a larger photo.
 5. Split: stratified, grouped 70/15/15 (train/validation/test), fixed seed.
 6. Leakage check: no test or validation image may be near identical to a training image.
 7. Encoding: class ids and one-hot columns; class weights from the training split.
 8. Scaling: pixels to 0-1 (min-max), then z-score with ImageNet mean/std (the pretrained
    weights expect it); the dataset's own mean/std is reported for comparison.
 9. Augmentation (training only), previewed in augmentation-examples.jpg.
10. Features for the hybrid model: CNN embeddings plus handcrafted colour, texture (LBP, GLCM),
    shape (HOG) and quality features. Scaling, feature selection and PCA are fitted on the
    training split only; the numbers here are a preview, training refits them inside each fold.

Usage:  python ml/scripts/preprocess.py
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

import imagehash
import torch
import numpy as np
import pandas as pd
from PIL import ExifTags, Image, ImageDraw
from skimage.feature import canny, graycomatrix, graycoprops, hog, local_binary_pattern
from skimage.filters import laplace
from skimage.measure import shannon_entropy
from sklearn.decomposition import PCA
from sklearn.feature_selection import mutual_info_classif
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    DEDUPLICATED,
    IMAGENET_MEAN,
    IMAGENET_STD,
    MANIFESTS,
    PROCESSED,
    REPORTS,
    SEED,
    Embedder,
    open_rgb,
)
from transforms import CLASSES, eval_view, train_transform  # noqa: E402

MAX_SIDE = 1024
JPEG_QUALITY = 92
MIN_SHORT_SIDE = 96
#: A pixel row or column darker than this on average (0-255) is letterbox padding. JPEG
#: ringing leaves a few brighter pixels in the bars, so the mean is used, not the maximum.
BAR_LEVEL = 24
#: Extra pixels trimmed past a detected bar, removing its blurred edge.
BAR_MARGIN = 3
SAME_PHOTO_SIMILARITY = 0.94
SAME_BURST_SECONDS = 30
LARGE_PHOTO_SHORT_SIDE = 900
RSD_CLASSES = {"Pot hole": "pothole", "Creak": "crack", "Asphalt": "asphalt_damage"}


# ---------------------------------------------------------------- 1. labels


def load_sources() -> pd.DataFrame:
    rsd = pd.read_csv(MANIFESTS / "rsd-bd-deduplication.csv")
    rsd = rsd[rsd["decision"] == "kept"].assign(dataset="rsd-bd")
    rsd["class"] = rsd["label"].map(RSD_CLASSES)
    det = pd.read_csv(MANIFESTS / "detection-deduplication.csv")
    det = det[det["decision"] == "kept"].assign(dataset="bangladesh-road-damage")
    # Detection "damage" photos mix potholes, cracks and broken surfaces under one box class,
    # so they train the detector only; their normal photos are the classifier's no_damage.
    det["class"] = det["label"].map({"normal": "no_damage", "damage": "damage_detection_only"})
    frame = pd.concat([rsd, det], ignore_index=True)[["dataset", "path", "label", "class", "camera"]]
    frame["camera"] = frame["camera"].fillna("")
    return frame


# ---------------------------------------------------------------- 2. cleaning


def letterbox(gray: np.ndarray) -> tuple[int, int, int, int]:
    """Bounding box (x0, y0, x1, y1) of the picture inside black padding bars."""
    height, width = gray.shape
    rows = np.where(gray.mean(axis=1) > BAR_LEVEL)[0]
    cols = np.where(gray.mean(axis=0) > BAR_LEVEL)[0]
    if rows.size == 0 or cols.size == 0:
        return 0, 0, width, height
    x0, y0, x1, y1 = int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1
    # Trim the soft edge of each bar that was found; edges without a bar stay untouched.
    x0 = x0 + BAR_MARGIN if x0 > 0 else 0
    y0 = y0 + BAR_MARGIN if y0 > 0 else 0
    x1 = x1 - BAR_MARGIN if x1 < width else width
    y1 = y1 - BAR_MARGIN if y1 < height else height
    return x0, y0, x1, y1


def capture_time(path: Path) -> datetime | None:
    with Image.open(path) as img:
        exif = img.getexif()
        value = exif.get_ifd(ExifTags.IFD.Exif).get(ExifTags.Base.DateTimeOriginal) or exif.get(ExifTags.Base.DateTime)
    if value:
        try:
            return datetime.strptime(str(value).strip(), "%Y:%m:%d %H:%M:%S")
        except ValueError:
            pass
    match = re.search(r"(20\d{6})[_-]?(\d{6})", path.name)
    return datetime.strptime(match[1] + match[2], "%Y%m%d%H%M%S") if match else None


def move_boxes(label_file: Path, crop: tuple[int, int, int, int], size: int) -> tuple[list[str], int, int]:
    """YOLO boxes from the padded size x size image, re-expressed inside the cropped picture.
    Returns the new label lines, how many boxes lost more than BAR_MARGIN + 1 px of an edge,
    and how many fell entirely inside the removed bars."""
    x0, y0, x1, y1 = crop
    width, height = x1 - x0, y1 - y0
    lines, trimmed, removed = [], 0, 0
    for line in label_file.read_text().splitlines():
        parts = line.split()
        if len(parts) != 5:
            continue
        cx, cy, w, h = (float(v) * size for v in parts[1:])
        left, top = max(cx - w / 2 - x0, 0), max(cy - h / 2 - y0, 0)
        right, bottom = min(cx + w / 2 - x0, width), min(cy + h / 2 - y0, height)
        if right - left < 2 or bottom - top < 2:
            removed += 1
            continue
        lost = (right - left < w - BAR_MARGIN - 1) or (bottom - top < h - BAR_MARGIN - 1)
        trimmed += int(lost)
        lines.append(
            f"0 {(left + right) / 2 / width:.6f} {(top + bottom) / 2 / height:.6f} "
            f"{(right - left) / width:.6f} {(bottom - top) / height:.6f}"
        )
    return lines, trimmed, removed


def clean(frame: pd.DataFrame) -> pd.DataFrame:
    target = PROCESSED / "images"
    labels_dir = PROCESSED / "labels"
    for folder in (target, labels_dir):
        if folder.exists():
            shutil.rmtree(folder)
    records = []
    for row in frame.itertuples():
        source = DEDUPLICATED / row.path
        img = open_rgb(source)
        original = img.size
        crop = (0, 0, *img.size)
        if row.dataset == "bangladesh-road-damage":
            crop = letterbox(np.asarray(img.convert("L")))
            img = img.crop(crop)
        bars = crop != (0, 0, *original)
        img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
        image_id = f"{'rsd' if row.dataset == 'rsd-bd' else 'det'}-{row.Index:04d}"
        out = target / row.dataset / row._4 / f"{image_id}.jpg"
        out.parent.mkdir(parents=True, exist_ok=True)
        img.save(out, "JPEG", quality=JPEG_QUALITY)  # no exif= argument: metadata is stripped
        boxes, trimmed, removed = None, 0, 0
        if row.dataset == "bangladesh-road-damage":
            label_file = Path(str(source).replace("/images/", "/labels/")).with_suffix(".txt")
            lines, trimmed, removed = move_boxes(label_file, crop, original[0])
            boxes = len(lines)
            (labels_dir / f"{image_id}.txt").parent.mkdir(parents=True, exist_ok=True)
            (labels_dir / f"{image_id}.txt").write_text("\n".join(lines) + ("\n" if lines else ""))
        gray = np.asarray(img.convert("L"), dtype=np.float32) / 255.0
        records.append(
            {
                "image_id": image_id,
                "processed_path": str(out.relative_to(PROCESSED)),
                "original_width": original[0],
                "original_height": original[1],
                "bars_cropped": bars,
                "crop_box": " ".join(map(str, crop)) if bars else "",
                "width": img.width,
                "height": img.height,
                "aspect": round(img.width / img.height, 3),
                "brightness": float(gray.mean()),
                "contrast": float(gray.std()),
                "sharpness": float(laplace(gray).var() * 1e4),
                "phash": str(imagehash.phash(img)),
                "boxes": boxes,
                "boxes_trimmed": trimmed,
                "boxes_removed": removed,
                "captured_at": capture_time(source) if row.dataset == "rsd-bd" else None,
            }
        )
    return pd.concat([frame, pd.DataFrame(records, index=frame.index)], axis=1)


# ---------------------------------------------------------------- 3. outliers


def flag_outliers(frame: pd.DataFrame) -> pd.DataFrame:
    frame["short_side"] = frame[["width", "height"]].min(axis=1)
    frame["dropped"] = np.where(frame["short_side"] < MIN_SHORT_SIDE, f"smaller than {MIN_SHORT_SIDE} px", "")
    flags = [[] for _ in range(len(frame))]
    for column in ("brightness", "contrast", "sharpness", "aspect"):
        values = np.log(frame[column]) if column in {"sharpness", "aspect"} else frame[column]
        q1, q3 = values.quantile([0.25, 0.75])
        low, high = q1 - 1.5 * (q3 - q1), q3 + 1.5 * (q3 - q1)
        for i, value in enumerate(values):
            if value < low:
                flags[i].append(f"low {column}")
            elif value > high:
                flags[i].append(f"high {column}")
    frame["outlier_flags"] = ["; ".join(f) for f in flags]
    return frame


# ---------------------------------------------------------------- 4. groups


def tiles(img: Image.Image) -> list[Image.Image]:
    """Square regions at four scales, so a close-up crop can be matched to its source photo."""
    out = [img]
    w, h = img.size
    for fraction in (1 / 2, 1 / 3, 1 / 4):
        side = int(min(w, h) * fraction)
        stride = max(side // 2, 1)
        for y in range(0, h - side + 1, stride):
            for x in range(0, w - side + 1, stride):
                out.append(img.crop((x, y, x + side, y + side)))
    return out


def group_photos(frame: pd.DataFrame, embeddings: np.ndarray, embedder: Embedder) -> tuple[list[int], dict]:
    n = len(frame)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    links = {"near_identical": 0, "crop_of_larger_photo": 0, "same_burst": 0}

    def union(a: int, b: int, reason: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
            links[reason] += 1

    # The two datasets come from different teams and places, so only photos within one dataset
    # are linked; across datasets, similar-looking road surfaces are not the same place.
    dataset = frame["dataset"].to_numpy()
    similarity = embeddings @ embeddings.T
    similar = (similarity >= SAME_PHOTO_SIMILARITY) & (dataset[:, None] == dataset[None, :])
    for i, j in zip(*np.where(np.triu(similar, 1))):
        union(int(i), int(j), "near_identical")

    large = [
        i
        for i, row in enumerate(frame.itertuples())
        if row.dataset == "rsd-bd" and min(row.original_width, row.original_height) >= LARGE_PHOTO_SHORT_SIDE
    ]
    for i in large:
        regions = embedder(tiles(Image.open(PROCESSED / frame["processed_path"].iat[i]).convert("RGB")))
        best = (embeddings @ regions.T).max(axis=1)
        best[(dataset != "rsd-bd") | (np.arange(n) == i)] = -1
        for j in np.where(best >= SAME_PHOTO_SIMILARITY)[0]:
            union(int(j), i, "crop_of_larger_photo")

    timed = sorted((t, i) for i, t in enumerate(frame["captured_at"]) if pd.notna(t))
    for (t1, a), (t2, b) in zip(timed, timed[1:]):
        if (t2 - t1).total_seconds() <= SAME_BURST_SECONDS:
            union(a, b, "same_burst")

    roots = [find(i) for i in range(n)]
    numbering = {root: k for k, root in enumerate(dict.fromkeys(roots), start=1)}
    return [numbering[r] for r in roots], links


# ---------------------------------------------------------------- 5-6. split and leakage


def split(frame: pd.DataFrame) -> list[str]:
    """Stratified, grouped 70/15/15: 20 folds, 14 train, 3 validation, 3 test."""
    folds = StratifiedGroupKFold(n_splits=20, shuffle=True, random_state=SEED)
    assignment = np.empty(len(frame), dtype=object)
    for k, (_, test_index) in enumerate(folds.split(frame, frame["class"], frame["group"])):
        assignment[test_index] = "train" if k < 14 else "validation" if k < 17 else "test"
    return assignment.tolist()


def leakage(frame: pd.DataFrame, embeddings: np.ndarray) -> dict:
    train = (frame["split"] == "train").to_numpy()
    result = {}
    hashes = [imagehash.hex_to_hash(h) for h in frame["phash"]]
    for name in ("validation", "test"):
        held = (frame["split"] == name).to_numpy()
        nearest = (embeddings[held] @ embeddings[train].T).max(axis=1)
        close_hash = sum(
            1
            for i in np.where(held)[0]
            if min(hashes[i] - hashes[j] for j in np.where(train)[0]) <= 4
        )
        result[name] = {
            "images": int(held.sum()),
            "near_identical_to_a_training_image": int((nearest >= SAME_PHOTO_SIMILARITY).sum()),
            "perceptual_hash_within_4_bits_of_a_training_image": close_hash,
            "nearest_training_similarity": {
                "median": round(float(np.median(nearest)), 3),
                "p95": round(float(np.percentile(nearest, 95)), 3),
                "max": round(float(nearest.max()), 3),
            },
            "groups_shared_with_train": int(
                len(set(frame.loc[held, "group"]) & set(frame.loc[train, "group"]))
            ),
        }
    return result


# ---------------------------------------------------------------- 10. handcrafted features


def handcrafted(img: Image.Image) -> tuple[np.ndarray, list[str]]:
    rgb = np.asarray(img, dtype=np.float32) / 255.0
    gray_img = img.convert("L")
    gray = np.asarray(gray_img, dtype=np.float32) / 255.0
    gray8 = np.asarray(gray_img, dtype=np.uint8)
    hsv = np.asarray(img.convert("HSV"), dtype=np.float32) / 255.0
    values, names = [], []

    def add(vector, prefix: str) -> None:
        vector = np.atleast_1d(np.asarray(vector, dtype=np.float32))
        values.append(vector)
        names.extend(f"{prefix}_{k}" if vector.size > 1 else prefix for k in range(vector.size))

    for c, channel in enumerate("hsv"):
        add(np.histogram(hsv[..., c], bins=8, range=(0, 1))[0] / gray.size, f"hist_{channel}")
    add(rgb.reshape(-1, 3).mean(0), "rgb_mean")
    add(rgb.reshape(-1, 3).std(0), "rgb_std")
    lbp = local_binary_pattern(gray8, P=8, R=1, method="uniform")
    add(np.histogram(lbp, bins=10, range=(0, 10))[0] / lbp.size, "lbp")
    glcm = graycomatrix(gray8 // 8, distances=[1, 3], angles=[0, np.pi / 2], levels=32, symmetric=True, normed=True)
    for prop in ("contrast", "homogeneity", "energy", "correlation"):
        add(graycoprops(glcm, prop).ravel(), f"glcm_{prop}")
    add(hog(np.asarray(gray_img.resize((128, 128))), orientations=9, pixels_per_cell=(32, 32), cells_per_block=(2, 2)), "hog")
    add(gray.mean(), "brightness")
    add(gray.std(), "contrast")
    add(laplace(gray).var() * 1e4, "sharpness")
    add(canny(gray, sigma=2).mean(), "edge_density")
    add(shannon_entropy(gray8), "entropy")
    add((gray < 0.15).mean(), "dark_fraction")
    return np.concatenate(values), names


# ---------------------------------------------------------------- report helpers


def augmentation_preview(frame: pd.DataFrame) -> None:
    torch.manual_seed(SEED)
    transform = train_transform(normalize=False)
    picks = frame[frame["split"] == "train"].groupby("class").head(1)
    picks = picks[picks["class"].isin(CLASSES)]
    sheet = Image.new("RGB", (7 * 160, len(picks) * 172), "white")
    draw = ImageDraw.Draw(sheet)
    for r, row in enumerate(picks.itertuples()):
        img = Image.open(PROCESSED / row.processed_path).convert("RGB")
        sheet.paste(eval_view(img).resize((156, 156)), (0, r * 172))
        draw.text((2, r * 172 + 158), f"{row._4} (original)", fill="black")
        for c in range(1, 7):
            tensor = transform(img)
            sheet.paste(Image.fromarray((tensor.permute(1, 2, 0).numpy() * 255).astype(np.uint8)).resize((156, 156)), (c * 160, r * 172))
    sheet.save(REPORTS / "augmentation-examples.jpg", quality=85)


def describe(series: pd.Series) -> dict:
    return {k: round(float(v), 3) for k, v in series.describe().items() if k != "count"}


def write_markdown(report: dict) -> None:
    """A readable summary of preprocessing.json (reports/preprocessing.md)."""
    names = {"pothole": "Pothole", "crack": "Crack", "asphalt_damage": "Asphalt damage", "no_damage": "No damage", "damage_detection_only": "Damage (detector only)"}
    split = report["split"]
    lines = [
        "# Preprocessing report",
        "",
        f"Generated by `scripts/preprocess.py` on {report['created']}. All numbers come from `preprocessing.json`.",
        "",
        f"**{report['images_in']} images in, {report['images_kept']} kept.**",
        "",
        "## Split (stratified, grouped 70/15/15)",
        "",
        "| Class | Train | Validation | Test | Total | Class weight |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for key, label in names.items():
        counts = [split[s].get(key, 0) for s in ("train", "validation", "test")]
        weight = report["class_weights_train"].get(key, "-")
        lines.append(f"| {label} | {counts[0]} | {counts[1]} | {counts[2]} | {sum(counts)} | {weight} |")
    leak, groups, boxes = report["leakage"], report["groups"], report["boxes"]
    outliers, letterbox, features = report["outliers"], report["letterbox"], report["features"]
    preview = features["preview_on_train_split"]
    lines += [
        "",
        "The classifier uses the first four classes. Damage photos from the detection dataset label",
        "potholes, cracks and broken surfaces as one box class, so they train the detector only.",
        "",
        "## Cleaning",
        "",
        "- EXIF orientation applied, converted to RGB, metadata stripped, saved at one JPEG quality.",
        f"- Longer side capped at {report['settings']['max_side']} px.",
        f"- Black letterbox bars removed from {letterbox['cropped']} detection-dataset photos. Normal photos had",
        "  bars at the sides and damage photos at the top and bottom, so a model could have learned the",
        "  bars instead of the road.",
        f"- Detection boxes moved to match: {boxes['total']} boxes, {boxes['trimmed_by_crop']} trimmed at a bar edge,",
        f"  {boxes['removed_by_crop']} removed (entirely inside a bar); damage photos left without a box: {boxes['damage_photos_without_boxes']}.",
        f"- Dropped {len(report['dropped'])} images under {report['settings']['min_short_side']} px on the short side.",
        f"- Flagged and kept {outliers['flagged']} outliers (IQR rule): "
        + ", ".join(f"{k} {v}" for k, v in outliers["by_flag"].items())
        + ". Real reports include dark, blurry and odd-shaped photos too.",
        "",
        "## Groups and leakage",
        "",
        f"Photos of the same place stay in one split. {groups['count']} groups, largest {groups['largest'][:5]}.",
        f"Links: {groups['links']['near_identical']} near-identical photo pairs, {groups['links']['crop_of_larger_photo']} close-up crops matched to",
        f"their larger photo, {groups['links']['same_burst']} photos taken within {report['settings']['same_burst_seconds']} s of each other.",
        "",
        "| Check | Validation | Test |",
        "|---|---:|---:|",
        f"| Images | {leak['validation']['images']} | {leak['test']['images']} |",
        f"| Groups shared with training | {leak['validation']['groups_shared_with_train']} | {leak['test']['groups_shared_with_train']} |",
        f"| Near identical to a training photo | {leak['validation']['near_identical_to_a_training_image']} | {leak['test']['near_identical_to_a_training_image']} |",
        f"| Perceptual hash within 4 bits of a training photo | {leak['validation']['perceptual_hash_within_4_bits_of_a_training_image']} | {leak['test']['perceptual_hash_within_4_bits_of_a_training_image']} |",
        f"| Nearest training similarity (median / max) | {leak['validation']['nearest_training_similarity']['median']} / {leak['validation']['nearest_training_similarity']['max']} | {leak['test']['nearest_training_similarity']['median']} / {leak['test']['nearest_training_similarity']['max']} |",
        "",
        "Perceptual-hash matches were checked by eye: different photos of plain roads, not copies.",
        "",
        "## Encoding and scaling",
        "",
        "- Class ids: " + ", ".join(f"{i} = {c}" for i, c in enumerate(report["classes"])) + "; one-hot columns `is_<class>` in `manifests/processed.csv`.",
        "- Pixels scaled to 0-1 (min-max), then z-scored with the ImageNet mean/std the pretrained weights expect.",
        f"  Training-split mean {report['scaling']['dataset_train_mean']}, std {report['scaling']['dataset_train_std']} for comparison.",
        "- Imbalance: class weights above, plus a balanced sampler and macro F1 during training.",
        "",
        "## Augmentation (training only)",
        "",
        "Random framing (50-100% of the photo), mirror, tilt up to 8 degrees without black corners,",
        "brightness/contrast/colour changes and occasional blur. No vertical flip. See `augmentation-examples.jpg`.",
        "",
        "## Features for the hybrid model",
        "",
        f"- {features['cnn_embedding']} CNN embedding values (MobileNetV3-Large, ImageNet) and {features['handcrafted']} handcrafted values:",
        "  " + ", ".join(features["handcrafted_groups"]) + ".",
        "- Preview on the training split (training refits these inside each cross-validation fold):",
        f"  - Most informative handcrafted features (mutual information): "
        + ", ".join(f"{f['feature']} ({f['mi']})" for f in preview["top_handcrafted"][:6])
        + ".",
        f"  - {preview['features_with_zero_mi']} features carry no information about the class.",
        f"  - PCA needs {preview['pca_components_for_90_95_99_percent'][0]} / {preview['pca_components_for_90_95_99_percent'][1]} / {preview['pca_components_for_90_95_99_percent'][2]} components for 90 / 95 / 99% of the variance.",
        "",
        "## Known risks",
        "",
        "- All no-damage photos come from one dataset and all classified damage from the other, so a model",
        "  could learn the dataset instead of the damage. Evaluation also scores the held-out damage photos",
        "  of the detection dataset, which must not be called no damage.",
        "- Crack photos are mostly full phone photos, pothole and asphalt photos mostly close-up crops.",
        "  Framing and resizing during augmentation reduce this; per-class results will show if it remains.",
        "",
    ]
    (REPORTS / "preprocessing.md").write_text("\n".join(lines))


def main() -> None:
    frame = load_sources()
    print(f"1. labels: {frame['class'].value_counts().to_dict()}")

    frame = clean(frame)
    print(f"2. cleaned {len(frame)} images; letterbox bars cropped on {int(frame['bars_cropped'].sum())}")

    frame = flag_outliers(frame)
    dropped = frame[frame["dropped"] != ""]
    for path in dropped["processed_path"]:
        (PROCESSED / path).unlink()
    kept = frame[frame["dropped"] == ""].reset_index(drop=True)
    print(f"3. dropped {len(dropped)} tiny images; flagged {int((kept['outlier_flags'] != '').sum())}")

    embedder = Embedder()
    views = [eval_view(Image.open(PROCESSED / p).convert("RGB")) for p in kept["processed_path"]]
    embeddings = embedder(views)
    kept["group"], links = group_photos(kept, embeddings, embedder)
    group_sizes = kept["group"].value_counts()
    print(f"4. {kept['group'].nunique()} groups, largest {group_sizes.head(5).tolist()}")

    kept["split"] = split(kept)
    leak = leakage(kept, embeddings)
    print(f"5-6. split {kept['split'].value_counts().to_dict()}; leakage {json.dumps(leak)}")

    classifier = kept[kept["class"].isin(CLASSES)]
    kept["class_id"] = kept["class"].map({c: i for i, c in enumerate(CLASSES)}).astype("Int64")
    for c in CLASSES:
        kept[f"is_{c}"] = (kept["class"] == c).astype(int)
    train_counts = classifier[classifier["split"] == "train"]["class"].value_counts()
    class_weights = {c: round(len(classifier[classifier["split"] == "train"]) / (len(CLASSES) * train_counts[c]), 4) for c in CLASSES}

    pixels = np.stack([np.asarray(v.resize((64, 64)), dtype=np.float32) / 255.0 for v in views])
    train_pixels = pixels[(kept["split"] == "train").to_numpy()]
    dataset_mean = [round(float(v), 3) for v in train_pixels.mean(axis=(0, 1, 2))]
    dataset_std = [round(float(v), 3) for v in train_pixels.std(axis=(0, 1, 2))]

    augmentation_preview(kept)

    features, names = zip(*(handcrafted(v) for v in views))
    handcrafted_matrix = np.stack(features)
    np.savez_compressed(
        PROCESSED / "features.npz",
        image_id=kept["image_id"].to_numpy(),
        cnn=embeddings,
        handcrafted=handcrafted_matrix,
        handcrafted_names=np.array(names[0]),
    )
    is_train = (kept["split"] == "train").to_numpy() & kept["class"].isin(CLASSES).to_numpy()
    combined = np.hstack([embeddings, handcrafted_matrix])
    combined_names = [f"cnn_{k}" for k in range(embeddings.shape[1])] + list(names[0])
    scaled = StandardScaler().fit_transform(combined[is_train])
    mutual_info = mutual_info_classif(scaled, kept.loc[is_train, "class"], random_state=SEED)
    order = np.argsort(mutual_info)[::-1]
    hand_mi = mutual_info[embeddings.shape[1] :]
    pca = PCA(random_state=SEED).fit(scaled)
    cumulative = np.cumsum(pca.explained_variance_ratio_)

    report = {
        "created": datetime.now().isoformat(timespec="seconds"),
        "settings": {
            "max_side": MAX_SIDE,
            "jpeg_quality": JPEG_QUALITY,
            "min_short_side": MIN_SHORT_SIDE,
            "letterbox_level": BAR_LEVEL,
            "letterbox_margin": BAR_MARGIN,
            "same_photo_similarity": SAME_PHOTO_SIMILARITY,
            "same_burst_seconds": SAME_BURST_SECONDS,
            "seed": SEED,
        },
        "classes": CLASSES,
        "images_in": int(len(frame)),
        "images_kept": int(len(kept)),
        "dropped": dropped[["path", "class", "width", "height", "dropped"]].to_dict("records"),
        "letterbox": {
            "cropped": int(frame["bars_cropped"].sum()),
            "by_class": frame[frame["bars_cropped"]]["class"].value_counts().to_dict(),
            "aspect_after_cleaning_by_class": {c: describe(g["aspect"]) for c, g in kept.groupby("class")},
        },
        "boxes": {
            "total": int(kept["boxes"].sum()),
            "trimmed_by_crop": int(kept["boxes_trimmed"].sum()),
            "removed_by_crop": int(kept["boxes_removed"].sum()),
            "damage_photos_without_boxes": int(((kept["class"] == "damage_detection_only") & (kept["boxes"] == 0)).sum()),
        },
        "outliers": {
            "flagged": int((kept["outlier_flags"] != "").sum()),
            "by_flag": kept["outlier_flags"].str.split("; ").explode().loc[lambda s: s != ""].value_counts().to_dict(),
        },
        "groups": {
            "count": int(kept["group"].nunique()),
            "links": links,
            "largest": group_sizes.head(10).tolist(),
            "single_photo_groups": int((group_sizes == 1).sum()),
        },
        "split": {
            s: kept[kept["split"] == s]["class"].value_counts().to_dict() for s in ("train", "validation", "test")
        },
        "leakage": leak,
        "class_weights_train": class_weights,
        "scaling": {
            "min_max": "pixel / 255 -> 0..1",
            "z_score_mean_used": IMAGENET_MEAN,
            "z_score_std_used": IMAGENET_STD,
            "dataset_train_mean": dataset_mean,
            "dataset_train_std": dataset_std,
        },
        "features": {
            "cnn_embedding": int(embeddings.shape[1]),
            "handcrafted": int(handcrafted_matrix.shape[1]),
            "handcrafted_groups": sorted({re.sub(r"_\d+$", "", n) for n in names[0]}),
            "preview_on_train_split": {
                "top_mutual_information": [
                    {"feature": combined_names[k], "mi": round(float(mutual_info[k]), 4)} for k in order[:15]
                ],
                "top_handcrafted": [
                    {"feature": names[0][k], "mi": round(float(hand_mi[k]), 4)} for k in np.argsort(hand_mi)[::-1][:10]
                ],
                "features_with_zero_mi": int((mutual_info == 0).sum()),
                "pca_components_for_90_95_99_percent": [int(np.searchsorted(cumulative, q) + 1) for q in (0.90, 0.95, 0.99)],
            },
        },
    }
    keep_columns = [
        "image_id", "dataset", "path", "processed_path", "label", "class", "class_id",
        *[f"is_{c}" for c in CLASSES], "group", "split", "width", "height", "original_width",
        "original_height", "bars_cropped", "crop_box", "boxes", "boxes_trimmed", "boxes_removed", "brightness",
        "contrast", "sharpness", "outlier_flags", "camera", "captured_at",
    ]
    kept[keep_columns].round(4).to_csv(MANIFESTS / "processed.csv", index=False)
    (REPORTS / "preprocessing.json").write_text(json.dumps(report, indent=2, default=str) + "\n")
    write_markdown(report)
    print(json.dumps({k: report[k] for k in ("split", "class_weights_train", "groups", "outliers", "boxes")}, indent=2, default=str))
    print(json.dumps(report["features"], indent=2))


if __name__ == "__main__":
    main()
