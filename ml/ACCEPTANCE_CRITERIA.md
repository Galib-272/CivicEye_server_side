# Model acceptance criteria (PRD §19.3)

Production activation requires **explicit approval** by the project owner. Until then
`AI_ENABLED` stays `false` in staging and production, and the model runs in development only.

These thresholds are a starting point set after the baseline below, for an **advisory** model
(a reviewer always decides). They must be revisited with real reports before launch.

| Requirement | Threshold | Current model (`road-damage-2026.11.08`) | Met? |
|---|---|---|---|
| Per-class F1, four-class answer (test) | ≥ 85% for every class | lowest 91.7% (asphalt damage) | Yes |
| Damage recall, step 1 (test) | ≥ 95% | 99.0% | Yes |
| Clear roads called damage, step 1 (test) | ≤ 5% | 1.9% | Yes |
| Same-source check: damaged photos called "no damage" | ≤ 5% | 1.9% (2 of 105) | Yes |
| Inference time per photo, CPU | ≤ 1 s median | about 0.2 s | Yes |
| Memory | ≤ 1 GB | about 530 MB | Yes |
| Evaluation on photos from **outside** the training datasets (other divisions, citizen photos, different phones) | Per-class F1 within 10 points of the test set | **Not measured** — no such labelled data yet | **No** |
| Calibration check before showing scores as probabilities | Expected calibration error ≤ 5% | Not measured; scores are shown as "model score", never as certainty | Not needed while scores are not shown as probabilities |
| Reviewer correction rate after launch | Investigate if > 20% over 4 weeks | Monitored at `GET /admin/ai/status` | After launch |

## Decision

**Not approved for production.** The model meets every threshold that could be measured, but it
has only been tested on photos from the same two datasets it learned from. Before approval:

1. Collect and label a separate set of Bangladeshi road photos (other places, phones and
   conditions; see [`ANNOTATION_GUIDELINES.md`](ANNOTATION_GUIDELINES.md)), with consent.
2. Evaluate the current model on it without retraining.
3. If it meets the thresholds, the project owner approves activation in staging first.

## Hardware and deployment constraints

- CPU only (no GPU on the server); 2 threads; one photo at a time.
- Runs as a separate private service; the backend sends the processed display photo (no
  original file, no metadata) with a shared token.
- Model files are versioned in git (`ml/models`, 62 MB) with SHA-256 checksums in `manifest.json`.
