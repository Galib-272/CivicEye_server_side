"""Model 1: MobileNetV3-Large fine-tuned for one step of the two-step classifier
(presence: damage or no damage; type: pothole, crack or asphalt damage).

Starts from the ImageNet weights. Stage 1 trains only the new final layer with the rest frozen;
stage 2 fine-tunes everything with a smaller learning rate for the pretrained layers. A balanced
sampler shows every class equally often (this replaces class weights in the loss, so the
imbalance is not corrected twice). Training stops when validation macro F1 has not improved
for PATIENCE epochs, and the best epoch is kept. The test split is not used here.

Writes ml/models/cnn-<task>.pt, ml/reports/cnn-<task>-history.csv and validation/test
probabilities to ml/data/processed/predictions/cnn-<task>.npz.

Usage:  python ml/scripts/train_cnn.py --task presence|type [--smoke]
"""

from __future__ import annotations

import argparse
import copy
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from sklearn.metrics import f1_score
from torch import nn
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler
from tqdm import tqdm

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import REPORTS, SEED, device  # noqa: E402
from data import MODELS, PREDICTIONS, manifest, prediction_rows, preload, seed_everything, task_rows  # noqa: E402
from transforms import TASKS, eval_transform, train_transform  # noqa: E402

BATCH = 32
HEAD_EPOCHS = 3
MAX_EPOCHS = 30
PATIENCE = 7
LABEL_SMOOTHING = 0.1


class Images(Dataset):
    def __init__(self, images, labels, transform):
        self.images, self.labels, self.transform = images, labels, transform

    def __len__(self) -> int:
        return len(self.images)

    def __getitem__(self, i):
        return self.transform(self.images[i]), self.labels[i]


def build_model(classes: int) -> nn.Module:
    from torchvision.models import MobileNet_V3_Large_Weights, mobilenet_v3_large

    model = mobilenet_v3_large(weights=MobileNet_V3_Large_Weights.IMAGENET1K_V2)
    model.classifier[3] = nn.Linear(model.classifier[3].in_features, classes)
    return model


@torch.no_grad()
def predict(model: nn.Module, images, batch: int = 64) -> np.ndarray:
    model.eval()
    transform = eval_transform()
    out = []
    for start in range(0, len(images), batch):
        x = torch.stack([transform(img) for img in images[start : start + batch]]).to(device())
        out.append(torch.softmax(model(x), dim=1).cpu().numpy())
    return np.concatenate(out)


def main(task: str, smoke: bool) -> None:
    seed_everything()
    classes = TASKS[task]
    frame = manifest()
    train, val = task_rows(frame, task, "train"), task_rows(frame, task, "validation")
    if smoke:
        train, val = train.groupby("target").head(8), val.groupby("target").head(4)
    label_of = {c: i for i, c in enumerate(classes)}
    y_train = train["target"].map(label_of).to_numpy()
    y_val = val["target"].map(label_of).to_numpy()
    train_images = preload(train, 320, "Loading training photos")
    val_images = preload(val, 256, "Loading validation photos")

    counts = np.bincount(y_train, minlength=len(classes))
    sampler = WeightedRandomSampler(
        weights=torch.tensor(1.0 / counts[y_train], dtype=torch.double),
        num_samples=len(y_train),
        replacement=True,
        generator=torch.Generator().manual_seed(SEED),
    )
    loader = DataLoader(Images(train_images, y_train, train_transform()), batch_size=BATCH, sampler=sampler)

    model = build_model(len(classes)).to(device())
    loss_fn = nn.CrossEntropyLoss(label_smoothing=LABEL_SMOOTHING)
    max_epochs = 2 if smoke else MAX_EPOCHS
    head_epochs = 1 if smoke else HEAD_EPOCHS
    history, best_f1, best_state, stale = [], -1.0, None, 0
    started = time.time()

    epochs = tqdm(range(1, max_epochs + 1), desc=f"CNN {task} training", unit="epoch")
    for epoch in epochs:
        if epoch == 1:
            for p in model.features.parameters():
                p.requires_grad = False
            optimizer = torch.optim.AdamW(model.classifier.parameters(), lr=1e-3, weight_decay=1e-4)
            scheduler = None
        if epoch == head_epochs + 1:
            for p in model.features.parameters():
                p.requires_grad = True
            optimizer = torch.optim.AdamW(
                [
                    {"params": model.features.parameters(), "lr": 1e-4},
                    {"params": model.classifier.parameters(), "lr": 5e-4},
                ],
                weight_decay=1e-4,
            )
            scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max_epochs - head_epochs)
        model.train()
        if epoch <= head_epochs:
            model.features.eval()  # frozen layers keep their ImageNet batch statistics
        total, seen = 0.0, 0
        for x, y in tqdm(loader, desc=f"  epoch {epoch}", unit="batch", leave=False):
            x, y = x.to(device()), y.to(device())
            optimizer.zero_grad()
            loss = loss_fn(model(x), y)
            loss.backward()
            optimizer.step()
            total += loss.item() * len(y)
            seen += len(y)
        if scheduler:
            scheduler.step()
        probabilities = predict(model, val_images)
        val_f1 = f1_score(y_val, probabilities.argmax(1), average="macro")
        val_acc = float((probabilities.argmax(1) == y_val).mean())
        history.append({"epoch": epoch, "train_loss": total / seen, "val_macro_f1": val_f1, "val_accuracy": val_acc})
        if val_f1 > best_f1:
            best_f1, best_state, stale = val_f1, copy.deepcopy(model.state_dict()), 0
        else:
            stale += 1
        epochs.set_postfix(loss=f"{total / seen:.3f}", val_f1=f"{val_f1:.3f}", best=f"{best_f1:.3f}")
        if epoch > head_epochs and stale >= PATIENCE:
            tqdm.write(f"Stopping early: no improvement for {PATIENCE} epochs.")
            break

    model.load_state_dict(best_state)
    best_epoch = max(history, key=lambda h: h["val_macro_f1"])["epoch"]
    tqdm.write(f"CNN {task}: best validation macro F1 {best_f1:.4f} at epoch {best_epoch} ({(time.time() - started) / 60:.1f} min)")

    MODELS.mkdir(exist_ok=True)
    torch.save({"state_dict": model.state_dict(), "classes": classes, "best_epoch": best_epoch}, MODELS / f"cnn-{task}.pt")
    pd.DataFrame(history).round(4).to_csv(REPORTS / f"cnn-{task}-history.csv", index=False)
    rows = prediction_rows(frame)
    probabilities = predict(model, preload(rows, 256, "Scoring validation and test photos"))
    PREDICTIONS.mkdir(parents=True, exist_ok=True)
    np.savez(PREDICTIONS / f"cnn-{task}.npz", image_id=rows["image_id"].to_numpy(dtype=str), probabilities=probabilities)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", choices=list(TASKS), required=True)
    parser.add_argument("--smoke", action="store_true", help="tiny run to check the script works")
    args = parser.parse_args()
    main(args.task, args.smoke)
