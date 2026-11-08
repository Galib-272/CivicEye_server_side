# Model card: CivicEye road damage model

**Version:** `road-damage-2026.11.08` (see [`models/manifest.json`](models/manifest.json) for files and checksums)
**State:** evaluated; **not approved for production** ([`ACCEPTANCE_CRITERIA.md`](ACCEPTANCE_CRITERIA.md)). Runs in development only.
**Owner:** CivicEye project. **Report:** [`reports/training.md`](reports/training.md).

## What it does

Given one photo of a road in Bangladesh, it suggests one of four answers, finds damage with boxes,
and warns about dark or blurry photos:

| Answer | Meaning |
|---|---|
| `pothole` | A hole in the road surface |
| `crack` | Cracking of any kind (longitudinal, transverse or alligator — not told apart) |
| `asphalt_damage` | Broken or worn asphalt, failed patches |
| `no_damage` | No visible road damage |

It is **decision support only** (PRD §16.1). It never accepts, rejects, routes, merges or
re-categorizes a report. Reviewers see the suggestion, decide themselves, and can record
whether the AI was right. A score is not a guaranteed probability (PRD §17.5).

**Not intended for:** judging severity or urgency, roads outside Bangladesh, night or flooded
scenes, photos of things other than roads, any automatic decision.

## How it works

Two steps, each an ensemble (average) of a fine-tuned **MobileNetV3-Large** CNN and a **hybrid**
model (CNN features + handcrafted colour, texture and shape features → z-score → mutual-information
feature selection → PCA → SVM):

1. **Damage or no damage?**
2. **If damage, which kind?** (pothole, crack, asphalt damage)

The answer combines them: P(no damage) from step 1; P(kind) = P(damage) × P(kind | damage).
Separately, an **SSDLite320-MobileNetV3** detector draws boxes around damage.

Why two steps: the first, single-step design learned *which dataset a photo came from* instead of
the damage (it called 63% of damaged photos from one dataset "no damage"). Step 1 is trained on a
dataset where damaged and clear roads come from the same phones and places, so the photo source
gives no clue. The rejected design is kept in [`reports/v1-single-step/`](reports/v1-single-step/).

## Training data

| Dataset | Licence | Used for |
|---|---|---|
| Bangladesh Road Damage Detection Dataset v1 (Tanim, Khan, Moni; DOI 10.17632/ktnx66vtmc.1) | CC BY 4.0 | Step 1 (damage / clear), detector boxes |
| RSD-BD v1 (Kowser et al.; DOI 10.17632/745n5wnt7v.1) | CC BY 4.0 | Step 1 (damage), step 2 (kind) |

All photos are Bangladeshi roads (highways, city and rural roads), taken with phones in daylight.
After removing 805 duplicate copies and 4 tiny images: **2,204 photos**, split 70/15/15 with photos
of the same place kept together (no test photo is a near copy of a training photo). Preprocessing:
[`reports/preprocessing.md`](reports/preprocessing.md). No citizen photo was used, and none will be
used without an explicit data-use policy (PRD §19.6).

## Results (test set, never used for training or choosing)

201 photos for the four-class answer; scores are macro averages (each class counts equally).

| Measure | Value |
|---|---:|
| Accuracy | 96.5% |
| Macro F1 (95% interval) | 94.9% (90.4–98.1%) |
| Balanced accuracy | 95.2% |
| Top-2 accuracy | 99.5% |

| Class | Precision | Recall | F1 | Photos |
|---|---:|---:|---:|---:|
| Pothole | 90.3% | 93.3% | 91.8% | 30 |
| Crack | 96.7% | 96.7% | 96.7% | 30 |
| Asphalt damage | 91.7% | 91.7% | 91.7% | 36 |
| No damage | 100.0% | 99.0% | 99.5% | 105 |

Step 1 alone (306 photos): damage found 99.0% (199 of 201), clear roads called damage 1.9% (2 of 105).
Same-source check (detection dataset only): 2 of 105 damaged and 2 of 105 clear photos wrong.

Detector (test): mAP@0.5 40.9%, mAP@0.5:0.95 18.1%; finds damage in 89.5% of damaged photos at
the chosen threshold (0.65), with 73.4% photo precision.

Speed and size (Apple M4 CPU, one photo): classification about 0.17 s, about 0.2 s with the
detector; about 530 MB memory with all models loaded; model files 62 MB. The AI service reproduces
the test results exactly (96.5% / 94.9%).

## Known failure modes and limits

- **Pothole and asphalt damage are confused** (5 of 66 test photos): both are broken surfaces.
- **Crack kinds are not distinguished**; reviewers pick longitudinal, transverse or alligator.
- **Small test set** (201 photos): the true macro F1 could reasonably be anywhere from about 90% to 98%.
- **Narrow conditions:** daylight phone photos from two datasets. Night, rain, flooding, motion
  blur, unusual angles, dashcams and roads outside the datasets' regions are untested.
- **All clear-road photos come from one dataset.** Step 1 handles this, but clear roads from other
  places may be called damage more often.
- **Boxes are rough:** mAP@0.5 of 41% means box positions are only a guide to where to look.
- **Scores are not calibrated probabilities.** Suggestions under 0.6 are shown as "uncertain".
- **Not a severity measure** (PRD §17.5).

## Monitoring and control

- Every prediction stores the model version; reviewers' agreements and corrections are stored
  with it (`ai_predictions` table) and summarised at `GET /admin/ai/status` (correction rate,
  failures, latency).
- `AI_ENABLED=false` stops new analyses at once; earlier suggestions stay visible.
- Rollback: deploy the previous `ml/models` folder (its manifest and checksums travel with it).
- The AI service refuses to start if any model file does not match its checksum.
