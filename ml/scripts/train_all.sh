#!/bin/bash
# Trains every model and writes the report, in order. Run from the server repo:
#   bash ml/scripts/train_all.sh            (add --smoke for a quick check of the whole chain)
set -euo pipefail
cd "$(dirname "$0")/../.."
PY="${PYTHON:-$HOME/.local/civiceye-tools/ml-venv/bin/python}"
export PYTORCH_ENABLE_MPS_FALLBACK=1
SMOKE="${1:-}"

step() { printf '\n\033[1m[%s] %s\033[0m\n' "$1" "$2"; }
started=$(date +%s)
step "1/6" "Step 1 CNN: damage or no damage"
"$PY" -I -W ignore ml/scripts/train_cnn.py --task presence $SMOKE
step "2/6" "Step 2 CNN: pothole, crack or asphalt damage"
"$PY" -I -W ignore ml/scripts/train_cnn.py --task type $SMOKE
step "3/6" "Step 1 hybrid (5-fold cross-validation)"
"$PY" -I -W ignore ml/scripts/train_hybrid.py --task presence $SMOKE
step "4/6" "Step 2 hybrid (5-fold cross-validation)"
"$PY" -I -W ignore ml/scripts/train_hybrid.py --task type $SMOKE
if [ -f ml/models/detector.pt ] && [ -z "$SMOKE" ]; then
  step "5/6" "Detector: already trained (ml/models/detector.pt), skipped"
else
  step "5/6" "Detector (SSDLite320-MobileNetV3)"
  "$PY" -I -W ignore ml/scripts/train_detector.py $SMOKE
fi
step "6/6" "Ensembles, test scores and report"
"$PY" -I -W ignore ml/scripts/evaluate.py
printf '\n\033[1mAll done in %d min. Report: ml/reports/training.md\033[0m\n' $(( ($(date +%s) - started) / 60 ))
