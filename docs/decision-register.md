# CivicEye decision register

Tracks product and engineering decisions required by the PRD (§37, §39). A decision moves to
**Decided** only with product-owner approval; approved product decisions are also written back
into the PRD. **Default** entries are reversible engineering choices made so work can proceed.

Last updated: 2026-11-04 (Phase 4).

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
| Launch area                   | Dhaka: Dhaka North and Dhaka South city corporations                                                              | 2026-11-04 |
| Organization creation         | Super Admin creates organizations; no self-registration at launch                                                 | 2026-11-04 |
| Verification evidence         | Official government email domain, confirmed by a named contact person at that domain                              | 2026-11-04 |
| Organization roles            | Org Admin, Reviewer (reviews reports, verifies work) and Worker                                                   | 2026-11-04 |
| Initial organization types    | City corporations only at launch                                                                                  | 2026-11-04 |
| Report visibility default     | Public by default; the reporting citizen's identity is never shown publicly                                       | 2026-11-04 |
| Public location precision     | Public views rounded to about 100 m; organizations see the exact point                                            | 2026-11-04 |
| Citizen editing               | Editable while SUBMITTED; afterwards only additional information; every edit kept                                 | 2026-11-04 |
| Citizen withdrawal            | Immediate while SUBMITTED or NEEDS_INFORMATION; not possible afterwards                                           | 2026-11-04 |
| Photo limits                  | 1–5 photos, 10 MB each, JPEG/PNG/WebP (HEIC: see Phase 4 notes); all metadata including GPS removed               | 2026-11-04 |
| Object storage                | Cloudflare R2 (staging/production); SeaweedFS locally (MinIO images are no longer published)                      | 2026-11-04 |
| Unrouted reports              | Reports outside every service area wait in a Super Admin triage list; never auto-assigned                         | 2026-11-04 |
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
| Map tiles: confirm OpenFreeMap for launch (no SLA) or choose a paid provider; geocoding   | Before launch                    |
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

## Phase 3 notes

- Approved defaults: invitations expire after 7 days; only Super Admins draw service areas;
  service-area limits 10,000 km², 50,000 points, 5 MB; the public profile shows name, type,
  description, website and public contact only.
- The official domain must end in `.gov.bd` (launch is in Bangladesh). Change
  `GOVERNMENT_DOMAIN_SUFFIXES` if other countries or domains are approved.
- Not built in Phase 3: organization logos (needs file storage, Phase 4), report routing
  (Phase 5), an interactive map (Phase 4), organization self-registration (not approved).

## Phase 4 notes

- HEIC photos are not accepted directly: the image library used on the server cannot decode
  them. The upload page asks for JPEG/PNG/WebP, so iPhones convert photos to JPEG on upload.
- Photos are not shown on public pages until the face and number-plate blurring decision is
  made; the reporter (and, from Phase 5, the organization) sees them.
- Map tiles come from OpenFreeMap (free, no key, commercial use allowed, no service guarantee).
  There is no address search; locations are set by map pin, device location or coordinates.
- Reports are routed when submitted: exactly one verified organization whose active service
  area covers the point receives it; none or several → Super Admin triage.
- Rate limits: 10 reports per hour and 30 per day per citizen; 60 photo uploads per hour.
- Cloudflare R2 needs a CORS rule allowing `PUT` and `GET` from the web origin with the
  `Content-Type` header; local storage gets it automatically (`STORAGE_CREATE_BUCKET`).
- Not built in Phase 4: adding information after SUBMITTED (with the Phase 5 review workflow),
  organization report views (Phase 5), public photos, address search, a map of all reports.

## Open — remaining PRD §37 items

appeal policy · public comment policy · minimum account age ·
authentication provider · worker availability rules · citizen satisfaction confirmation ·
report priority policy · emergency issue handling · data retention schedule · account deletion
and anonymization · AI training data consent · AI production acceptance thresholds · AI hardware
budget · RPO and RTO · production hosting provider · expected initial traffic · load targets ·
face and number-plate blurring in public photos · rejection reason codes · Bangla category names.
