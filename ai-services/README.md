# CivicEye AI service

Internal FastAPI service that analyses road photos with the models in [`../ml/models`](../ml/models)
(PRD §16–17). Its results are **advisory only**: the backend stores them, reviewers see them,
and people make every decision. Model details, scores and limits: [`../ml/MODEL_CARD.md`](../ml/MODEL_CARD.md).

## What it does

`POST /v1/analyze` with one photo (multipart field `image`) returns:

- `label`: `pothole`, `crack`, `asphalt_damage` or `no_damage`, with `confidence` and all
  `probabilities` (two steps: damage or not, then which damage)
- `uncertain`: true when the top score is under the manifest's threshold (0.6); the reviewer decides
- `detections`: boxes around damage, as fractions (0–1) of the upright photo's width and height
- `quality.warnings`: `too_dark`, `blurry`
- `modelVersion`, stored with every prediction

`GET /health` (no token) returns the model version. `GET /v1/model` returns the manifest summary.

## Safety

- Every request except `/health` needs `Authorization: Bearer $AI_SERVICE_TOKEN` (32+ characters).
- On startup every model file is checked against its SHA-256 in `manifest.json`; a mismatch stops the service.
- Uploads over 10 MB or that are not images are refused. It keeps nothing: no photo is stored or logged.
- Run it on a private network only, reachable by the CivicEye backend and nothing else.

## Run locally

```bash
cd ai-services
export AI_SERVICE_TOKEN=$(openssl rand -hex 32)   # put the same value in the backend's .env
uvicorn app.main:app --host 127.0.0.1 --port 8090
```

Python 3.12 with [`requirements.txt`](requirements.txt). Tests: `pip install -r requirements-test.txt && pytest`.

| Variable | Default | Meaning |
|---|---|---|
| `AI_SERVICE_TOKEN` | required | Shared secret with the backend |
| `AI_MODEL_DIR` | `../ml/models` | Folder with `manifest.json` and the model files |
| `AI_MAX_IMAGE_BYTES` | 10485760 | Largest accepted upload |
| `AI_THREADS` | 2 | CPU threads for inference |

Measured on an Apple M4 CPU: about 0.2 s per photo and about 530 MB peak memory with all models loaded.
