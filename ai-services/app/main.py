"""CivicEye's internal AI inference service (PRD §17).

Reachable only by the CivicEye backend on a private network, and every request except the
health check must carry the shared token. It analyses one photo at a time and returns advisory
results only: the backend stores them, and people make every decision.

Environment:
    AI_SERVICE_TOKEN   required, at least 32 characters; the backend sends it as a bearer token
    AI_MODEL_DIR       folder with manifest.json and the model files (default: ml/models)
    AI_MAX_IMAGE_BYTES largest accepted upload (default: 10 MB)
    AI_THREADS         CPU threads for inference (default: 2)

Run:  uvicorn app.main:app --host 127.0.0.1 --port 8090   (from ai-services/)
"""

from __future__ import annotations

import hmac
import io
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel

from app.predictor import REPO, Predictor

Image.MAX_IMAGE_PIXELS = 40_000_000  # refuse decompression bombs


class Settings:
    def __init__(self) -> None:
        self.token = os.environ.get("AI_SERVICE_TOKEN", "")
        if len(self.token) < 32:
            raise RuntimeError("AI_SERVICE_TOKEN must be set to at least 32 characters")
        self.model_dir = Path(os.environ.get("AI_MODEL_DIR", REPO / "ml" / "models"))
        self.max_image_bytes = int(os.environ.get("AI_MAX_IMAGE_BYTES", 10 * 1024 * 1024))
        self.threads = int(os.environ.get("AI_THREADS", 2))


class Detection(BaseModel):
    box: list[float]
    score: float


class Quality(BaseModel):
    brightness: float
    sharpness: float
    warnings: list[str]


class Analysis(BaseModel):
    modelVersion: str
    label: str
    confidence: float
    uncertain: bool
    probabilities: dict[str, float]
    damageProbability: float
    detections: list[Detection]
    quality: Quality
    timingsMs: dict[str, float]


state: dict = {}


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = Settings()
    state["settings"] = settings
    state["predictor"] = Predictor(settings.model_dir, settings.threads)  # fails on bad checksums
    yield
    state.clear()


app = FastAPI(title="CivicEye AI service", version="1.0.0", lifespan=lifespan, docs_url=None, redoc_url=None)


def authorized(authorization: str = Header(default="")) -> None:
    expected = f"Bearer {state['settings'].token}"
    if not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "modelVersion": state["predictor"].version}


@app.get("/v1/model", dependencies=[Depends(authorized)])
def model() -> dict:
    manifest = state["predictor"].manifest
    return {k: manifest[k] for k in ("version", "classes", "thresholds", "evaluation_test_set", "approval_state")}


@app.post("/v1/analyze", dependencies=[Depends(authorized)], response_model=Analysis)
def analyze(image: UploadFile = File(...)) -> dict:
    limit = state["settings"].max_image_bytes
    data = image.file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status_code=413, detail="image_too_large")
    try:
        photo = Image.open(io.BytesIO(data))
        photo.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise HTTPException(status_code=422, detail="unreadable_image") from None
    return state["predictor"].analyze(photo)
