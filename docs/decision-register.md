# CivicEye decision register

Tracks product and engineering decisions required by the PRD (§37, §39). A decision moves to
**Decided** only with product-owner approval; approved product decisions are also written back
into the PRD. **Default** entries are reversible engineering choices made so work can proceed.

Last updated: 2026-11-04 (Phase 1).

## Decided

| Decision                      | Outcome                                                                | Date       |
| ----------------------------- | ---------------------------------------------------------------------- | ---------- |
| Architecture review (Phase 0) | Approved; Phase 1 approved as proposed                                 | 2026-11-04 |
| Technology stack              | As PRD §11.1, §12.1, §17.1                                             | 2026-11-04 |
| Package manager               | npm                                                                    | 2026-11-04 |
| Repository layout             | Two GitHub repositories: CivicEye_server_side and CivicEye_client_side | 2026-11-04 |

## Engineering defaults (reversible)

| Topic                | Default                                                                                  | Why / how to change                                                           |
| -------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Node.js              | 24 LTS (`.nvmrc`)                                                                        | Current LTS line.                                                             |
| Session architecture | Server-managed sessions in Redis with an opaque HttpOnly cookie; no JWT/refresh endpoint | PRD §37 recommendation. Implemented in Phase 2; please confirm.               |
| Default UI language  | English, with automatic redirect to Bangla for browsers that prefer it                   | Change `defaultLocale` in `civiceye_client_side/src/i18n/routing.ts`.         |
| Bangla UI text       | Written during development                                                               | **Needs review by a native Bangla speaker before launch.**                    |
| Global rate limit    | 300 requests/minute per client, Redis-backed, fails open if Redis is down                | Security-critical limits (login, reset) will fail closed (Phase 2).           |
| CI provider          | GitHub Actions, one workflow per repository                                              | Repositories are hosted on GitHub.                                            |
| Frontend CSP         | Baseline headers only; nonce-based CSP in Phase 2                                        | A strict CSP needs per-request nonces through `src/proxy.ts`.                 |
| Local Redis image    | `redis:7.4-alpine` (development only)                                                    | The production Redis/Valkey provider and its licence are chosen with hosting. |

## Open — needed by the next phases

| Decision                                                                                  | Needed by                        |
| ----------------------------------------------------------------------------------------- | -------------------------------- |
| Email verification requirement                                                            | Phase 2                          |
| Email delivery provider (development uses Mailpit)                                        | Phase 2                          |
| MFA for Super Admins (proposed: required, TOTP)                                           | Phase 2                          |
| Org-level roles: separate reviewer/supervisor role in the MVP?                            | Phase 2–3                        |
| Who creates organizations (self-registration or Super Admin)                              | Phase 3                          |
| Organization verification evidence                                                        | Phase 3                          |
| Exact initial launch geography                                                            | Phase 3                          |
| Public vs. private report default                                                         | Phase 4                          |
| Citizen editing and withdrawal policies                                                   | Phase 4                          |
| Image upload limits; object storage provider                                              | Phase 4                          |
| Map tile and geocoding providers                                                          | Phase 4                          |
| State-machine gaps G1–G12 from the architecture review                                    | Phase 4–6                        |
| Service-area overlap and transfer policies                                                | Phase 5                          |
| Assignment acknowledgement and completion verification policies                           | Phase 6                          |
| Update PRD §32.1 (one repository) to the approved two-repository layout                   | Before Phase 2                   |
| Detection model licence path (Ultralytics AGPL-3.0 vs. paid licence vs. Apache-2.0 model) | Phase 9                          |
| Whether CivicEye will be open source                                                      | Phase 9 (affects the item above) |

## Open — remaining PRD §37 items

Initial organization types · appeal policy · public comment policy · minimum account age ·
authentication provider · worker availability rules · citizen satisfaction confirmation ·
report priority policy · emergency issue handling · data retention schedule · account deletion
and anonymization · AI training data consent · AI production acceptance thresholds · AI hardware
budget · RPO and RTO · production hosting provider · expected initial traffic · load targets ·
face and number-plate blurring in public photos · rejection reason codes · Bangla category names.
