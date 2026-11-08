"""Tests for the AI service, with the real trained models from ml/models."""

from __future__ import annotations

import io
import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import main
from app.predictor import REPO, ModelIntegrityError, Predictor

FIXTURES = Path(__file__).parent / "fixtures"
TOKEN = "t" * 40
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture(scope="module")
def client():
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("AI_SERVICE_TOKEN", TOKEN)
        with TestClient(main.app) as test_client:
            yield test_client


def jpeg(color=(128, 128, 128), size=(320, 240)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, "JPEG")
    return buffer.getvalue()


def analyze(client, data: bytes, headers=AUTH, name="photo.jpg"):
    return client.post("/v1/analyze", files={"image": (name, data, "image/jpeg")}, headers=headers)


def test_health_reports_the_model_version(client):
    response = client.get("/health")
    assert response.status_code == 200
    manifest = json.loads((REPO / "ml" / "models" / "manifest.json").read_text())
    assert response.json() == {"status": "ok", "modelVersion": manifest["version"]}


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}, {"Authorization": TOKEN}])
def test_requests_without_the_token_are_refused(client, headers):
    assert analyze(client, jpeg(), headers=headers).status_code == 401
    assert client.get("/v1/model", headers=headers).status_code == 401


@pytest.mark.parametrize("label", ["pothole", "crack", "asphalt_damage", "no_damage"])
def test_known_test_photos_are_classified(client, label):
    response = analyze(client, (FIXTURES / f"{label}.jpg").read_bytes())
    assert response.status_code == 200
    body = response.json()
    assert body["label"] == label
    assert body["uncertain"] is False
    assert abs(sum(body["probabilities"].values()) - 1) < 1e-3
    assert body["quality"]["warnings"] == []
    for detection in body["detections"]:
        x0, y0, x1, y1 = detection["box"]
        assert 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1


def test_damage_photos_get_boxes_and_clear_roads_none(client):
    assert len(analyze(client, (FIXTURES / "pothole.jpg").read_bytes()).json()["detections"]) >= 1
    assert analyze(client, (FIXTURES / "no_damage.jpg").read_bytes()).json()["detections"] == []


def test_a_dark_photo_gets_a_warning(client):
    body = analyze(client, jpeg(color=(5, 5, 5))).json()
    assert "too_dark" in body["quality"]["warnings"]
    assert "blurry" in body["quality"]["warnings"]  # a flat image has no edges at all


def test_unreadable_and_oversized_uploads_are_refused(client):
    assert analyze(client, b"not an image").status_code == 422
    limit = main.state["settings"].max_image_bytes
    assert analyze(client, b"0" * (limit + 1)).status_code == 413


def test_model_details_need_the_token(client):
    body = client.get("/v1/model", headers=AUTH).json()
    assert body["classes"] == ["pothole", "crack", "asphalt_damage", "no_damage"]
    assert "not approved for production" in body["approval_state"]


def test_a_changed_model_file_stops_the_service(tmp_path):
    models = REPO / "ml" / "models"
    for item in models.iterdir():
        shutil.copy(item, tmp_path / item.name)
    with (tmp_path / "detector.pt").open("ab") as handle:
        handle.write(b"tampered")
    with pytest.raises(ModelIntegrityError, match="detector.pt"):
        Predictor(tmp_path)


def test_a_short_token_stops_the_service(monkeypatch):
    monkeypatch.setenv("AI_SERVICE_TOKEN", "short")
    with pytest.raises(RuntimeError, match="AI_SERVICE_TOKEN"):
        main.Settings()
