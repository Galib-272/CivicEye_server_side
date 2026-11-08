"""The network shapes used by CivicEye's models, built without downloading anything when
pretrained=False (the AI service loads trained weights from ml/models instead)."""

from __future__ import annotations

from torch import nn


def build_classifier(classes: int, pretrained: bool = True) -> nn.Module:
    """MobileNetV3-Large with a new final layer for `classes` outputs."""
    from torchvision.models import MobileNet_V3_Large_Weights, mobilenet_v3_large

    model = mobilenet_v3_large(weights=MobileNet_V3_Large_Weights.IMAGENET1K_V2 if pretrained else None)
    model.classifier[3] = nn.Linear(model.classifier[3].in_features, classes)
    return model


def build_detector() -> nn.Module:
    """SSDLite320-MobileNetV3-Large with one class (damage) plus background, no weights."""
    from torchvision.models.detection import ssdlite320_mobilenet_v3_large

    return ssdlite320_mobilenet_v3_large(weights=None, weights_backbone=None, num_classes=2)
