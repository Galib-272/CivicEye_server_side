"""Model 4: SSDLite320-MobileNetV3 road damage detector (draws boxes around damage).

Trained on the Bangladesh Road Damage Detection photos (letterbox bars already removed):
damage photos with their boxes, and normal photos as examples with nothing to find. Starts
from the COCO weights; only the class layer is new (one class: damage). The checkpoint with
the best validation mAP@0.5 is kept. The score threshold for "damage found" is chosen on the
validation split, then the test split is scored once.

Writes ml/models/detector.pt and ml/reports/detector.json.

Usage:  python ml/scripts/train_detector.py [--smoke]
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader, Dataset
from torchvision import tv_tensors
from torchvision.ops import box_iou
from torchvision.transforms import v2
from tqdm import tqdm

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import PRETRAINED, PROCESSED, REPORTS, device  # noqa: E402
from data import MODELS, manifest, preload, seed_everything  # noqa: E402

BATCH = 16
EPOCHS = 60
EVAL_EVERY = 3
DETECTION_CLASSES = ["no_damage", "damage_detection_only"]


def boxes_for(image_id: str, width: int, height: int) -> torch.Tensor:
    rows = []
    for line in (PROCESSED / "labels" / f"{image_id}.txt").read_text().splitlines():
        _, cx, cy, w, h = map(float, line.split())
        rows.append([(cx - w / 2) * width, (cy - h / 2) * height, (cx + w / 2) * width, (cy + h / 2) * height])
    return torch.tensor(rows, dtype=torch.float32).reshape(-1, 4)


class Photos(Dataset):
    def __init__(self, frame, images, train: bool):
        self.ids, self.images = frame["image_id"].tolist(), images
        self.transform = (
            v2.Compose(
                [
                    v2.ToImage(),
                    v2.RandomHorizontalFlip(),
                    v2.RandomPhotometricDistort(p=0.5),
                    v2.ToDtype(torch.float32, scale=True),
                    v2.SanitizeBoundingBoxes(),
                ]
            )
            if train
            else v2.Compose([v2.ToImage(), v2.ToDtype(torch.float32, scale=True)])
        )

    def __len__(self) -> int:
        return len(self.ids)

    def __getitem__(self, i):
        img = self.images[i]
        boxes = tv_tensors.BoundingBoxes(boxes_for(self.ids[i], img.width, img.height), format="XYXY", canvas_size=(img.height, img.width))
        target = {"boxes": boxes, "labels": torch.ones(len(boxes), dtype=torch.int64)}
        image, target = self.transform(img, target)
        return image, target


def collate(batch):
    return tuple(zip(*batch))


def build_model() -> torch.nn.Module:
    from torchvision.models.detection import ssdlite320_mobilenet_v3_large

    model = ssdlite320_mobilenet_v3_large(weights=None, weights_backbone=None, num_classes=2)
    coco = torch.load(PRETRAINED / "hub" / "checkpoints" / "ssdlite320_mobilenet_v3_large_coco-a79551df.pth", map_location="cpu")
    own = model.state_dict()
    # Everything except the class layer (91 COCO classes -> background + damage) is reused.
    usable = {k: v for k, v in coco.items() if k in own and own[k].shape == v.shape}
    own.update(usable)
    model.load_state_dict(own)
    return model


def average_precision(scores, matched, positives: int) -> float:
    """Area under the precision-recall curve (all-point interpolation, as in Pascal VOC)."""
    if positives == 0:
        return float("nan")
    order = np.argsort(-np.asarray(scores))
    hits = np.asarray(matched, dtype=float)[order]
    tp, fp = np.cumsum(hits), np.cumsum(1 - hits)
    recall = tp / positives
    precision = tp / np.maximum(tp + fp, 1e-9)
    recall = np.concatenate([[0], recall, [1]])
    precision = np.concatenate([[0], precision, [0]])
    for i in range(len(precision) - 2, -1, -1):
        precision[i] = max(precision[i], precision[i + 1])
    steps = np.where(recall[1:] != recall[:-1])[0]
    return float(np.sum((recall[steps + 1] - recall[steps]) * precision[steps + 1]))


def match(outputs, targets, iou_threshold: float):
    """Detection scores with whether each one matched an unclaimed true box."""
    scores, matched, positives = [], [], 0
    for out, target in zip(outputs, targets):
        truth = target["boxes"]
        positives += len(truth)
        order = torch.argsort(out["scores"], descending=True)
        claimed = torch.zeros(len(truth), dtype=torch.bool)
        ious = box_iou(out["boxes"][order], truth) if len(truth) and len(order) else None
        for rank, k in enumerate(order):
            scores.append(float(out["scores"][k]))
            hit = False
            if ious is not None:
                best = torch.argmax(ious[rank])
                if ious[rank, best] >= iou_threshold and not claimed[best]:
                    claimed[best] = hit = True
            matched.append(hit)
    return scores, matched, positives


@torch.no_grad()
def run(model, dataset) -> tuple[list, list]:
    model.eval()
    outputs, targets = [], []
    for images, batch_targets in DataLoader(dataset, batch_size=BATCH, collate_fn=collate):
        results = model([img.to(device()) for img in images])
        outputs += [{k: v.cpu() for k, v in r.items()} for r in results]
        targets += [{k: v for k, v in t.items()} for t in batch_targets]
    return outputs, targets


def box_metrics(outputs, targets) -> dict:
    ap50 = average_precision(*match(outputs, targets, 0.5))
    ap_range = [average_precision(*match(outputs, targets, t)) for t in np.arange(0.5, 0.96, 0.05)]
    return {"map50": ap50, "map50_95": float(np.mean(ap_range))}


def photo_metrics(outputs, targets, threshold: float) -> dict:
    """Per photo: is any damage found (a box scoring at least the threshold)?"""
    found = np.array([bool((o["scores"] >= threshold).any()) for o in outputs])
    truth = np.array([len(t["boxes"]) > 0 for t in targets])
    tp, fp = int((found & truth).sum()), int((found & ~truth).sum())
    fn, tn = int((~found & truth).sum()), int((~found & ~truth).sum())
    precision = tp / max(tp + fp, 1)
    recall = tp / max(tp + fn, 1)
    return {
        "threshold": round(threshold, 2),
        "accuracy": (tp + tn) / len(truth),
        "precision": precision,
        "recall": recall,
        "f1": 2 * precision * recall / max(precision + recall, 1e-9),
        "confusion": {"damage_found": tp, "damage_missed": fn, "false_alarm": fp, "correctly_clear": tn},
    }


def box_counts(outputs, targets, threshold: float) -> dict:
    kept = [{"boxes": o["boxes"][o["scores"] >= threshold], "scores": o["scores"][o["scores"] >= threshold]} for o in outputs]
    _, matched, positives = match(kept, targets, 0.5)
    tp = int(sum(matched))
    precision = tp / max(len(matched), 1)
    recall = tp / max(positives, 1)
    return {"box_precision": precision, "box_recall": recall, "box_f1": 2 * precision * recall / max(precision + recall, 1e-9)}


def main(smoke: bool) -> None:
    seed_everything()
    frame = manifest()
    frame = frame[frame["class"].isin(DETECTION_CLASSES)]
    parts = {s: frame[frame["split"] == s].reset_index(drop=True) for s in ("train", "validation", "test")}
    if smoke:
        parts = {s: p.groupby("class").head(8).reset_index(drop=True) for s, p in parts.items()}
    data = {s: Photos(p, preload(p, 320, f"Loading {s} photos"), train=s == "train") for s, p in parts.items()}

    model = build_model().to(device())
    loader = DataLoader(data["train"], batch_size=BATCH, shuffle=True, collate_fn=collate, generator=torch.Generator().manual_seed(0))
    epochs_total = 2 if smoke else EPOCHS
    optimizer = torch.optim.SGD(model.parameters(), lr=0.01, momentum=0.9, weight_decay=4e-5)
    warmup = torch.optim.lr_scheduler.LinearLR(optimizer, start_factor=0.1, total_iters=len(loader) * 2)
    cosine = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=len(loader) * max(epochs_total - 2, 1))
    scheduler = torch.optim.lr_scheduler.SequentialLR(optimizer, [warmup, cosine], milestones=[len(loader) * 2])

    history, best_map, best_state = [], -1.0, None
    started = time.time()
    bar = tqdm(range(1, epochs_total + 1), desc="Detector training", unit="epoch")
    for epoch in bar:
        model.train()
        total = 0.0
        for images, targets in tqdm(loader, desc=f"  epoch {epoch}", unit="batch", leave=False):
            images = [img.to(device()) for img in images]
            targets = [{k: v.to(device()) for k, v in t.items()} for t in targets]
            losses = model(images, targets)
            loss = sum(losses.values())
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            scheduler.step()
            total += loss.item()
        entry = {"epoch": epoch, "train_loss": total / len(loader)}
        if epoch % EVAL_EVERY == 0 or epoch == epochs_total:
            entry.update(box_metrics(*run(model, data["validation"])))
            if entry["map50"] > best_map:
                best_map, best_state = entry["map50"], copy.deepcopy(model.state_dict())
        history.append(entry)
        bar.set_postfix(loss=f"{entry['train_loss']:.3f}", val_map50=f"{best_map:.3f}")

    model.load_state_dict(best_state)
    tqdm.write(f"Detector: best validation mAP@0.5 {best_map:.4f} ({(time.time() - started) / 60:.1f} min)")
    val_out = run(model, data["validation"])
    thresholds = np.arange(0.1, 0.9, 0.05)
    best_threshold = float(max(thresholds, key=lambda t: photo_metrics(*val_out, t)["f1"]))
    test_out = run(model, data["test"])
    report = {
        "model": "SSDLite320-MobileNetV3-Large, COCO start, 1 class (damage)",
        "photos": {s: {"total": len(p), "with_damage": int((p["class"] == "damage_detection_only").sum())} for s, p in parts.items()},
        "boxes": {s: int(sum(len(data[s][i][1]["boxes"]) for i in range(len(data[s])))) for s in ("validation", "test")},
        "best_validation_epoch": max((h for h in history if "map50" in h), key=lambda h: h["map50"])["epoch"],
        "threshold_chosen_on_validation": round(best_threshold, 2),
        "validation": {**box_metrics(*val_out), **box_counts(*val_out, best_threshold), "photos": photo_metrics(*val_out, best_threshold)},
        "test": {**box_metrics(*test_out), **box_counts(*test_out, best_threshold), "photos": photo_metrics(*test_out, best_threshold)},
        "history": history,
        "minutes": round((time.time() - started) / 60, 1),
    }
    if smoke:
        tqdm.write(json.dumps(report["test"], default=float)[:400])
        return
    MODELS.mkdir(exist_ok=True)
    torch.save({"state_dict": model.state_dict(), "threshold": best_threshold}, MODELS / "detector.pt")
    (REPORTS / "detector.json").write_text(json.dumps(report, indent=2, default=lambda v: round(float(v), 4)) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--smoke", action="store_true", help="tiny run to check the script works")
    main(parser.parse_args().smoke)
