# CivicEye AI services

**Not implemented.** No model, inference service or AI feature exists yet.

This directory will hold the internal Python FastAPI inference service (PRD §17), built in
Phase 9 after dataset licences are verified and a baseline model is trained and evaluated.
It will run as a separate process reachable only from the backend's private network, and
every prediction will record the model version that produced it.

Until then, nothing in CivicEye depends on AI, and no AI results are shown anywhere.
