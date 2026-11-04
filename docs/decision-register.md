# CivicEye decision register

Tracks product and engineering decisions required by the PRD (§37, §39). A decision moves to
**Decided** only with product-owner approval; approved product decisions are also written back
into the PRD. **Default** entries are reversible engineering choices made so work can proceed.

Last updated: 2026-11-04 (Phase 1).

## Decided

| Decision                      | Outcome                                                                                                           | Date       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------- |
| Architecture review (Phase 0) | Approved; Phase 1 approved as proposed                                                                            | 2026-11-04 |
| Technology stack              | As PRD §11.1, §12.1, §17.1                                                                                        | 2026-11-04 |
| Package manager               | npm                                                                                                               | 2026-11-04 |
| Repository layout             | Two GitHub repositories: CivicEye_server_side and CivicEye_client_side                                            | 2026-11-04 |
| Email verification            | Required before submitting reports, commenting or joining an organization; login allowed before verifying         | 2026-11-04 |
| Email delivery provider       | Resend (staging/production); Mailpit in local development                                                         | 2026-11-04 |
| Two-factor login              | Required for Super Admins (authenticator app + backup codes); optional for Org Admins now, required before launch | 2026-11-04 |
| Session lifetimes             | Citizens 7 days / 24 h idle; Super Admins 12 h / 30 min idle                                                      | 2026-11-04 |
| Password policy               | 12–128 characters, not common, no name/email; no composition rules                                                | 2026-11-04 |
| Session architecture          | Server-managed sessions in Redis, opaque HttpOnly cookie, no JWT or refresh tokens                                | 2026-11-04 |

## Engineering defaults (reversible)

| Topic               | Default                                                                   | Why / how to change                                                           |
| ------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Node.js             | 24 LTS (`.nvmrc`)                                                         | Current LTS line.                                                             |
| Default UI language | English, with automatic redirect to Bangla for browsers that prefer it    | Change `defaultLocale` in `civiceye_client_side/src/i18n/routing.ts`.         |
| Bangla UI text      | Written during development                                                | **Needs review by a native Bangla speaker before launch.**                    |
| Global rate limit   | 300 requests/minute per client, Redis-backed, fails open if Redis is down | Security-critical limits (login, reset) will fail closed (Phase 2).           |
| CI provider         | GitHub Actions, one workflow per repository                               | Repositories are hosted on GitHub.                                            |
| Frontend CSP        | Baseline headers only; nonce-based CSP in Phase 2                         | A strict CSP needs per-request nonces through `src/proxy.ts`.                 |
| Local Redis image   | `redis:7.4-alpine` (development only)                                     | The production Redis/Valkey provider and its licence are chosen with hosting. |

## Open — needed by the next phases

| Decision                                                                                  | Needed by                        |
| ----------------------------------------------------------------------------------------- | -------------------------------- |
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
| Resend sending domain (a domain you own, verified in Resend)                              | Before staging                   |
| Update PRD §32.1 (one repository) to the approved two-repository layout                   | Before Phase 2                   |
| Detection model licence path (Ultralytics AGPL-3.0 vs. paid licence vs. Apache-2.0 model) | Phase 9                          |
| Whether CivicEye will be open source                                                      | Phase 9 (affects the item above) |

## Phase 2 notes

- Permissions and organization roles are defined in code (`permissions.ts`), not database tables,
  until an administration screen needs to edit them.
- Not built in Phase 2: an admin user-management screen (the API exists), account deletion
  (needs the deletion/retention policy), and regenerating backup codes or turning two-factor off.
- Emails are sent in the background without retries until the Phase 7 outbox.

## Open — remaining PRD §37 items

Initial organization types · appeal policy · public comment policy · minimum account age ·
authentication provider · worker availability rules · citizen satisfaction confirmation ·
report priority policy · emergency issue handling · data retention schedule · account deletion
and anonymization · AI training data consent · AI production acceptance thresholds · AI hardware
budget · RPO and RTO · production hosting provider · expected initial traffic · load targets ·
face and number-plate blurring in public photos · rejection reason codes · Bangla category names.
