"""Image transforms shared by preprocessing, training and evaluation.

Every image is scaled to 0-1 (min-max) and then z-scored with the ImageNet mean/std, because
the pretrained MobileNetV3 weights were trained on images scaled that way.
"""

from __future__ import annotations

import torch
from PIL import Image
from torchvision.transforms import v2

from common import IMAGENET_MEAN, IMAGENET_STD

#: What CivicEye reports, in class-id order.
CLASSES = ["pothole", "crack", "asphalt_damage", "no_damage"]
#: The two steps that produce it: is there damage, and if so, which kind.
TASKS = {"presence": ["damage", "no_damage"], "type": ["pothole", "crack", "asphalt_damage"]}
SIZE = 224
ROTATE_FROM = 256


def eval_view(img: Image.Image) -> Image.Image:
    """The deterministic view used for validation, testing and feature extraction:
    shorter side to 256 px, then the central 224 x 224 square (no padding, so no bars)."""
    return v2.Compose([v2.Resize(256), v2.CenterCrop(SIZE)])(img)


def train_transform(normalize: bool = True) -> v2.Compose:
    """Training-only augmentation: framing, mirror, slight tilt (no black corners), light and colour changes, blur.
    No vertical flip: a road photo is never upside down."""
    steps = [
        v2.ToImage(),
        v2.RandomResizedCrop(ROTATE_FROM, scale=(0.5, 1.0), ratio=(3 / 4, 4 / 3), antialias=True),
        v2.RandomHorizontalFlip(),
        # Tilt, then keep the centre: a 256 px square turned by up to 8 degrees still fully
        # covers the central 224 px, so no black corners appear (they would be a false cue).
        v2.RandomRotation(8),
        v2.CenterCrop(SIZE),
        v2.ColorJitter(brightness=0.3, contrast=0.3, saturation=0.2, hue=0.02),
        v2.RandomApply([v2.GaussianBlur(5, sigma=(0.1, 1.5))], p=0.2),
        v2.ToDtype(torch.float32, scale=True),
    ]
    if normalize:
        steps.append(v2.Normalize(IMAGENET_MEAN, IMAGENET_STD))
    return v2.Compose(steps)


def eval_transform() -> v2.Compose:
    return v2.Compose(
        [
            v2.ToImage(),
            v2.Resize(256, antialias=True),
            v2.CenterCrop(SIZE),
            v2.ToDtype(torch.float32, scale=True),
            v2.Normalize(IMAGENET_MEAN, IMAGENET_STD),
        ]
    )
