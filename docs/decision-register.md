# CivicEye decision register

Tracks product and engineering decisions required by the PRD (§37, §39). A decision moves to
**Decided** only with product-owner approval; approved product decisions are also written back
into the PRD. **Default** entries are reversible engineering choices made so work can proceed.

Last updated: 2026-11-06 (Phase 8).

## Decided

| Decision                       | Outcome                                                                                                                     | Date       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Architecture review (Phase 0)  | Approved; Phase 1 approved as proposed                                                                                      | 2026-11-04 |
| Technology stack               | As PRD §11.1, §12.1, §17.1                                                                                                  | 2026-11-04 |
| Package manager                | npm                                                                                                                         | 2026-11-04 |
| Repository layout              | Two GitHub repositories: CivicEye_server_side and CivicEye_client_side                                                      | 2026-11-04 |
| Email verification             | Required before submitting reports, commenting or joining an organization; login allowed before verifying                   | 2026-11-04 |
| Email delivery provider        | Resend (staging/production); Mailpit in local development                                                                   | 2026-11-04 |
| Two-factor login               | Required for Super Admins (authenticator app + backup codes); optional for Org Admins now, required before launch           | 2026-11-04 |
| Session lifetimes              | Citizens 7 days / 24 h idle; Super Admins 12 h / 30 min idle                                                                | 2026-11-04 |
| Password policy                | 12–128 characters, not common, no name/email; no composition rules                                                          | 2026-11-04 |
| Launch area                    | Dhaka: Dhaka North and Dhaka South city corporations                                                                        | 2026-11-04 |
| Organization creation          | Super Admin creates organizations; no self-registration at launch                                                           | 2026-11-04 |
| Verification evidence          | Official government email domain, confirmed by a named contact person at that domain                                        | 2026-11-04 |
| Organization roles             | Org Admin, Reviewer (reviews reports, verifies work) and Worker                                                             | 2026-11-04 |
| Initial organization types     | City corporations only at launch                                                                                            | 2026-11-04 |
| Report visibility default      | Public by default; the reporting citizen's identity is never shown publicly                                                 | 2026-11-04 |
| Public location precision      | Public views rounded to about 100 m; organizations see the exact point                                                      | 2026-11-04 |
| Citizen editing                | Editable while SUBMITTED; afterwards only additional information; every edit kept                                           | 2026-11-04 |
| Citizen withdrawal             | Immediate while SUBMITTED or NEEDS_INFORMATION; not possible afterwards                                                     | 2026-11-04 |
| Photo limits                   | 1–5 photos, 10 MB each, JPEG/PNG/WebP (HEIC: see Phase 4 notes); all metadata including GPS removed                         | 2026-11-04 |
| Object storage                 | Cloudflare R2 (staging/production); SeaweedFS locally (MinIO images are no longer published)                                | 2026-11-04 |
| Unrouted reports               | Reports outside every service area wait in a Super Admin triage list; never auto-assigned                                   | 2026-11-04 |
| Project purpose                | Portfolio project: free services only; technical choices delegated to the developer, each phase still approved              | 2026-11-06 |
| Review start                   | A reviewer starts the review explicitly (SUBMITTED → UNDER_REVIEW)                                                          | 2026-11-06 |
| Information requests           | Message required; the citizen answers with text and optional photos (5 in total); no automatic timeout                      | 2026-11-06 |
| Acceptance rule                | Category must be one the organization handles; location in its area unless sent there by a Super Admin/transfer             | 2026-11-06 |
| Rejection reasons              | Not a civic issue, not enough information, already fixed, inappropriate, no answer, other — plus a message                  | 2026-11-06 |
| Transfer policy                | Reason required; to an organization covering the location and category, or back to triage; restarts at SUBMITTED            | 2026-11-06 |
| Internal notes                 | Org reviewers/admins and Super Admins only; append-only; not visible to another organization after a transfer               | 2026-11-06 |
| Public updates                 | Organization posts; Super Admin can hide one with a reason (audited)                                                        | 2026-11-06 |
| Reporter identity              | Never shown to organizations; contact only through information requests and public updates                                  | 2026-11-06 |
| Assignment                     | One active worker per report (database-enforced); only active, available Workers of the organization; no teams              | 2026-11-06 |
| Task acceptance                | Worker accepts before starting, or declines with a reason; no automatic timeout                                             | 2026-11-06 |
| Returning a task               | Worker returns it with a reason (unsafe, inaccessible, partly done); report goes back to ACCEPTED                           | 2026-11-06 |
| Worker leaves the organization | Open tasks are cancelled automatically; submitted work stays for the verifier                                               | 2026-11-06 |
| Completion evidence            | Description plus 1–5 after photos; submitting moves the report straight to PENDING_VERIFICATION                             | 2026-11-06 |
| Verification                   | Approved → RESOLVED; Rejected or Needs more evidence → IN_PROGRESS for the same worker; never one's own work                | 2026-11-06 |
| Reopen and close               | Reviewer reopens a resolved report with a reason, or closes it; closed is final                                             | 2026-11-06 |
| Citizen feedback               | "Is it fixed?" once per resolution; feedback only, never changes the status                                                 | 2026-11-06 |
| Worker privacy                 | Workers never see the reporter or internal notes; citizens never see which worker did the job                               | 2026-11-06 |
| Notifications                  | In-app for every important event; only to the people concerned, never to the actor; at most one per event and person        | 2026-11-06 |
| Emails                         | Optional per group (my reports, my tasks, organization work), on by default; generic subject, report ID and link only       | 2026-11-06 |
| Email provider                 | Brevo free plan through SMTP in staging/production (no paid service, no domain needed); Mailpit locally                     | 2026-11-06 |
| Reliable delivery              | Transactional outbox; retries with growing delays; FAILED after 8 attempts, retried manually by a Super Admin               | 2026-11-06 |
| Auto-close                     | Resolved reports close automatically after 14 days unless reopened                                                          | 2026-11-06 |
| Acceptance reminder            | Reviewers are reminded once when a task is not accepted within 48 hours; nothing changes automatically                      | 2026-11-06 |
| Live updates                   | Socket.IO with one-time 60-second tickets; messages carry no data, browsers re-fetch through the API                        | 2026-11-06 |
| Public map                     | Public reports only, rounded to about 100 m; withdrawn and duplicate reports never shown; at most 2,000 per view            | 2026-11-06 |
| Duplicate radius               | Per category (pothole, streetlight 30 m; road damage, garbage 50 m; drainage, waterlogging 150 m; else parent, then 50 m)   | 2026-11-06 |
| Duplicate candidates           | Same category family, within the radius, open or resolved in the last 30 days; not withdrawn, rejected or duplicate         | 2026-11-06 |
| Linking duplicates             | Reviewers link only within their organization (else transfer), SUBMITTED to ACCEPTED, reason required, no chains, final     | 2026-11-06 |
| Nearby warning                 | While reporting, public reports of the same kind within twice the radius (max 300 m) are shown; submitting is never blocked | 2026-11-06 |
| Session architecture           | Server-managed sessions in Redis, opaque HttpOnly cookie, no JWT or refresh tokens                                          | 2026-11-04 |

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

| Decision                                                                                                                 | Needed by                     |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| Map tiles: confirm OpenFreeMap for launch (no SLA) or choose a paid provider; geocoding                                  | Before launch                 |
| Validate duplicate radii with real reports (PRD §10.5)                                                                   | Before launch                 |
| Appeal policy (G7) and public comment policy                                                                             | Later phase                   |
| Assignment acknowledgement and completion verification policies                                                          | Phase 6                       |
| Resend sending domain (a domain you own, verified in Resend)                                                             | Before staging                |
| Update PRD §32.1 (one repository) to the approved two-repository layout                                                  | Before Phase 2                |
| Whether CivicEye will be open source                                                                                     | Before launch                 |
| Approve the AI for production after an evaluation on photos from outside the training data (`ml/ACCEPTANCE_CRITERIA.md`) | Before enabling AI in staging |

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

## Phase 5 notes

- Resolved gaps: G1 (unrouted reports → triage), G8 (withdrawal from SUBMITTED or
  NEEDS_INFORMATION only), G10 (transfer policy above), G11 (no timeout for information
  requests).
- Overlapping service areas stay a Super Admin decision (triage); there are no automatic
  jurisdiction priority rules.
- Super Admins can view any report (each view is audited) but do not make review decisions on
  an organization's behalf.
- Review actions send `If-Match` with the report version; a decision on a report someone else
  just changed is refused (409), so two reviewers cannot overwrite each other.
- Not built in Phase 5: notifications (Phase 7), worker assignment (Phase 6), appeals and
  citizen comments (policies not decided), duplicate marking (Phase 8).

## Phase 6 notes

- Resolved gaps: G2/G3 (decline and return go back to ACCEPTED), G4 (needs more evidence goes
  back to IN_PROGRESS), G5 (WORK_COMPLETED is recorded, then automatically
  PENDING_VERIFICATION), G6 (REOPENED → ASSIGNED only), G9 (CLOSED, REJECTED, WITHDRAWN and
  DUPLICATE are final), G12 (citizen satisfaction is separate feedback).
- A reopened report that is assigned and then released returns to ACCEPTED, not REOPENED.
- Assignments keep their state and timestamps in `report_assignments`; who, what and for whom
  cannot change (database trigger), and every change is an append-only `assignment_events` row.
- Work photos (progress and completion) are linked to the assignment, not the report, so they
  never count toward the report's 5 photos; the reporter sees completion photos once resolved.
- Not built in Phase 6: notifications (Phase 7), automatic closing and acceptance deadlines
  (Phase 7 background jobs), teams, appeals and public comments.

## Phase 7 notes

- Every status change records an outbox event inside `applyTransition`, so no change can skip
  notifications and no notification exists for a change that rolled back. Other events
  (new report, routing, updates, assignments, verification, "not fixed") are recorded next to
  their change. Event payloads hold IDs only.
- The dispatcher runs in worker processes every 2 seconds (`SKIP LOCKED`, safe with several
  workers). Emails go through a BullMQ queue with 5 attempts and stable job IDs; every attempt
  is recorded and a notification is never emailed twice.
- Account emails (verification, password reset, invitations) are retried in the same process
  (after 2 s and 10 s) instead of a queue, so their one-time links are never stored.
- Small gap: if a worker crashes after creating notifications but before queuing their emails,
  those emails are not sent (the in-app notifications remain).
- Not built in Phase 7: push notifications and SMS (future in the PRD).

## Phase 8 notes

- Coordinates are WGS84 (EPSG:4326) everywhere. Distances use PostGIS `geography`
  (`ST_DWithin`, `ST_Distance`, geodesic metres) on the GiST-indexed `reports.location`; the
  map uses a bounding-box (`&&`) query on the same index; organization outlines are
  `ST_Union` + `ST_SimplifyPreserveTopology` (about 50 m tolerance) for display only.
- The duplicate radii are starting values; the PRD requires checking them against real data
  before launch (open item below). Super Admins can change them on the Categories page.
- Candidates are computed when a report is submitted or moved; pairs are stored once and
  shown in both directions. Image-based duplicate detection arrives with the AI phase.
- The application now refuses to start when two handlers share a method and path (found when
  a Phase 8 endpoint duplicated a Phase 3 one).
- Not built in Phase 8: address search (needs a free geocoding provider), image similarity.

## Phase 9 notes

- Datasets: Bangladeshi roads only, both CC BY 4.0 (registry in `ml/README.md`). A third
  dataset was rejected because part of it is Google Earth imagery.
- Models: torchvision MobileNetV3 and SSDLite (BSD licence), so the detection licence question
  (Ultralytics AGPL-3.0) does not arise: no YOLO code or weights are used.
- The first single-step classifier learned the photo source; it was replaced by a two-step
  design (damage or not, then which kind). Both results are kept in `ml/reports`.
- The AI is advisory only and off by default (`AI_ENABLED=false`). Production activation needs
  explicit approval (`ml/ACCEPTANCE_CRITERIA.md`); not approved yet.
- Model files are committed (62 MB) with SHA-256 checksums; datasets are not (download script).
- Not built in Phase 9: text-based category suggestion, image-similarity duplicates, a Super
  Admin screen for AI status (the API exists).

## Phase 10 notes

- Metric definitions are in `docs/metrics.md`. Days are counted in Bangladesh time; durations
  under 5 cases are shown as "too few cases to judge".
- Moderation is decided by Super Admins only (approved default). Organizations escalate but do
  not moderate. No automatic hiding or suspension from flags or the AI (PRD §28.3).
- Flag limit: 20 per user per hour (starting value).
- Not built in Phase 10: a reporter-reputation score, appeals against moderation decisions
  (appeal policy is still open), charts beyond simple bars, export of dashboard data.

## Open — remaining PRD §37 items

appeal policy · public comment policy · minimum account age ·
authentication provider · worker availability rules (beyond available/unavailable) ·
report priority policy · emergency issue handling · data retention schedule · account deletion
and anonymization · AI training data consent · AI hardware budget · RPO and RTO · production hosting provider · expected initial traffic · load targets ·
face and number-plate blurring in public photos · Bangla category names.
