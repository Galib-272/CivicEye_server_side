"""Handcrafted image features for the hybrid model: colour, texture (LBP, GLCM), shape (HOG)
and quality. Shared by preprocessing, evaluation and the AI service, so features are computed
the same way everywhere."""

from __future__ import annotations

import numpy as np
from PIL import Image
from skimage.feature import canny, graycomatrix, graycoprops, hog, local_binary_pattern
from skimage.filters import laplace
from skimage.measure import shannon_entropy


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
