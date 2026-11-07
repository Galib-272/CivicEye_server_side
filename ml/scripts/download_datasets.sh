#!/bin/bash
# Downloads the approved CivicEye datasets from their official Mendeley Data records into
# ml/data/raw and verifies each file against the SHA-256 checksum the publisher lists.
# Dataset files are never committed to git; this script recreates them exactly.
#
# Usage (from the repository root):  bash ml/scripts/download_datasets.sh
set -euo pipefail
DEST="$(cd "$(dirname "$0")/.." && pwd)/data/raw"
mkdir -p "$DEST"
cd "$DEST"

fetch() {
  local name="$1" url="$2" sha="$3"
  if [ -f "$name" ] && [ "$(shasum -a 256 "$name" | awk '{print $1}')" = "$sha" ]; then
    echo "$name: already present and verified"
    return
  fi
  echo "$name: downloading"
  curl -fsSL --retry 3 -o "$name.part" "$url"
  local actual
  actual=$(shasum -a 256 "$name.part" | awk '{print $1}')
  if [ "$actual" != "$sha" ]; then
    rm -f "$name.part"
    echo "$name: checksum mismatch (expected $sha, got $actual)" >&2
    exit 1
  fi
  mv "$name.part" "$name"
  echo "$name: verified"
}

# Bangladesh Road Damage Detection Dataset v1 (Tanim, Khan, Moni; Khwaja Yunus Ali University)
# https://data.mendeley.com/datasets/ktnx66vtmc/1 — CC BY 4.0
fetch bangladesh-road-damage.zip \
  "https://data.mendeley.com/public-files/datasets/ktnx66vtmc/files/b4f5b4be-b64b-46e0-b604-b457c79ae568/file_downloaded" \
  00dc2f25a9acec7fabde63a37cb6d4f8ca2e92497b2f2956e4a4719d959e8085

# RSD-BD v1 (Kowser et al.; Daffodil International University)
# https://data.mendeley.com/datasets/745n5wnt7v/1 — CC BY 4.0
fetch rsd-bd.zip \
  "https://data.mendeley.com/public-files/datasets/745n5wnt7v/files/3c80c13c-2ff5-4e7c-aec8-1ab416d80acd/file_downloaded" \
  1922e743d3f98e69798f19b11d9694cbfc2f38b807f0db70f3b89dde4d00ab55

echo "All datasets present and verified in $DEST"
