# CivicEye ML workspace

Data preparation, training and evaluation for CivicEye's advisory AI (PRD §16–19, Phase 9).
CivicEye serves Bangladesh only, so every dataset used here was captured on Bangladeshi roads.

**Status (2026-11-07):** datasets downloaded, verified and inspected (reports in `reports/`);
training not done yet. No model exists and no AI result is shown anywhere in CivicEye.

## Setup

Datasets are **not committed** (they are large; see "Why datasets are not in git"). One command
recreates them exactly, verified against the publishers' SHA-256 checksums:

```bash
bash ml/scripts/download_datasets.sh      # into ml/data/raw (ignored by git)
```

Training tools are pinned in [`requirements.txt`](requirements.txt) (Python 3.12):

```bash
uv venv --python 3.12 .venv && uv pip install -r ml/requirements.txt
```

## Dataset registry (PRD §18.2)

Licences and provenance were checked on each official record on 2026-11-07.

| Dataset | Official record | Publisher | Licence | Images | Labels | Decision |
|---|---|---|---|---|---|---|
| Bangladesh Road Damage Detection Dataset, v1 | [Mendeley Data ktnx66vtmc](https://data.mendeley.com/datasets/ktnx66vtmc/1) | T. H. Tanim, M. R. Khan, M. M. I. Moni — Khwaja Yunus Ali University | CC BY 4.0 (commercial use allowed, attribution required) | Not stated; counted during preprocessing | Bounding boxes (YOLOv8 format), one class "pothole" covering potholes, cracks and broken surfaces; includes normal road images | **Approved.** Captured with three phone cameras on Bangladeshi highways, urban and rural roads. |
| RSD-BD, v1 | [Mendeley Data 745n5wnt7v](https://data.mendeley.com/datasets/745n5wnt7v/1) | K. A. Kowser et al. — Daffodil International University | CC BY 4.0 | 1,607 files (stated: 1,500); **802 unique** after removing exact copies and re-saved or resized copies (`scripts/deduplicate.py`) | Class per folder: Asphalt, Creak (crack), Pot hole | **Approved with conditions.** 209 unique photos carry phone camera metadata (OPPO A77s, Samsung SM-G935F); the rest are smaller crops consistent with the same photos, no watermarks or stock imagery. Duplicates are removed before splitting, and crops of one photo are kept in the same split. |
| Multi-class Road-Surface Condition Dataset, v1 | [Mendeley Data c43y93xswd](https://data.mendeley.com/datasets/c43y93xswd/1) | K. Moni et al. | CC BY 4.0 as stated | 7,489 crops from 3,154 images | Polygons, 6 classes | **Rejected.** Part of the source imagery is Google Earth, which the authors cannot license; the PRD forbids training on data with unclear rights (§18.3). |
| RDD2022 (CRDDC 2022) | [Figshare 21431547](https://figshare.com/articles/dataset/RDD2022_-_The_multi-national_Road_Damage_Dataset_released_through_CRDDC_2022/21431547) | Arya et al. | Paper: CC BY-SA 4.0; dataset licence not verified (official page blocked automated access) | 47,420 | Boxes, 4 classes | **Pending; not used.** No Bangladeshi images; licence unverified. |

### Attribution

- Tanim, T. H., Khan, M. R., Moni, M. M. I. *Bangladesh Road Damage Detection Dataset*,
  Mendeley Data, v1. DOI 10.17632/ktnx66vtmc.1. Licensed under CC BY 4.0.
- Kowser, K. A. et al. *RSD-BD: Road Surface Damage Image Dataset from Major Cities of
  Bangladesh*, Mendeley Data, v1. DOI 10.17632/745n5wnt7v.1. Licensed under CC BY 4.0


## Why datasets are not in git

GitHub refuses files over 100 MB, and committing hundreds of megabytes of images would slow
every clone, CI run and deployment. The download script, checksums, this registry, the split
lists and the trained models are committed instead, so the work is fully reproducible.
