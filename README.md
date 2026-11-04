# CivicEye — server

Backend for **CivicEye**, a civic issue reporting, tracking and resolution platform. Citizens
report problems such as potholes or broken streetlights, the responsible organization reviews and
repairs them, and an authorized person verifies the work.

The web app lives in a separate repository: [CivicEye_client_side](https://github.com/Galib-272/CivicEye_client_side).

> **Status: Phase 3 (organizations).** Accounts and access control (Phase 2) plus
> organizations: Super Admin creation and verification, members and invitations, issue
> categories, and service areas stored in PostGIS. Reports, maps and AI come in later phases.
> See the [decision register](docs/decision-register.md) for what is decided and what is open.

## Stack

NestJS (modular monolith) · TypeScript · PostgreSQL 17 + PostGIS 3 via Prisma · Redis ·
BullMQ · S3-compatible object storage (Cloudflare R2; SeaweedFS locally) · sharp · OpenAPI. The internal AI service ([`ai-services/`](ai-services)) and ML work
([`ml/`](ml)) will live in this repository; neither exists yet.

## Prerequisites

- **Node.js 24 LTS** (see [`.nvmrc`](.nvmrc)) and npm
- **Docker** for PostgreSQL/PostGIS and Redis, and for the integration tests. Either Docker
  Desktop, or [Colima](https://github.com/abiosoft/colima) with the `docker` CLI and Docker
  Compose. With Colima, start it with `colima start --vm-type vz --cpu 2 --memory 4 --disk 20`
  and, before running the integration tests:

  ```bash
  export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
  export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
  ```

PostGIS runs from a small image built from [`docker/postgis/Dockerfile`](docker/postgis/Dockerfile)
(official `postgres:17` plus PostGIS from the PGDG repository), because the upstream
`postgis/postgis` images are published for amd64 only and do not run natively on Apple silicon.

## Local setup

```bash
docker compose up -d --build     # or: docker-compose up -d --build
cp .env.example .env
npm install
npm run db:migrate
npm run dev
npm run worker:dev               # second terminal: processes uploaded photos
```

- API: <http://localhost:4000>
- API docs: <http://localhost:4000/api/docs>
- Readiness: <http://localhost:4000/api/v1/health/ready>
- Development mail (Mailpit, used from Phase 2): <http://localhost:8025>
- Local object storage (SeaweedFS S3 API): <http://127.0.0.1:8333>

## Commands

| Task                             | Command                                   |
| -------------------------------- | ----------------------------------------- |
| Develop (watch mode)             | `npm run dev`                             |
| Background worker (watch / prod) | `npm run worker:dev` / `npm run worker`   |
| Lint / format check              | `npm run lint` / `npm run format:check`   |
| Type check                       | `npm run typecheck`                       |
| Unit tests                       | `npm test`                                |
| Integration tests (needs Docker) | `npm run test:integration`                |
| Build / start                    | `npm run build` / `npm start`             |
| Apply migrations                 | `npm run db:migrate`                      |
| Create a migration               | `npm run db:migrate:dev -- --name <name>` |
| Export OpenAPI                   | `npm run openapi:export`                  |
| Create a Super Admin             | `npm run admin:create`                    |

**After changing an API endpoint**, run `npm run openapi:export` and commit
`openapi/openapi.json`. CI fails if it is stale. The web app copies this file
(`npm run api:sync` in the client repository) to regenerate its typed API client.

## Environment variables (`.env`)

Validated at startup: the API exits with a list of invalid variable names (never their values).

| Variable                    | Required | Default                 | Purpose                                             |
| --------------------------- | -------- | ----------------------- | --------------------------------------------------- |
| `NODE_ENV`                  | yes      | —                       | `development`, `test`, `staging` or `production`    |
| `PORT`                      | no       | `4000`                  | HTTP port                                           |
| `WEB_URL`                   | yes      | —                       | Frontend URL; its origin is the allowed CORS origin |
| `CORS_EXTRA_ORIGINS`        | no       | empty                   | Extra allowed origins, comma-separated              |
| `TRUST_PROXY`               | no       | `false`                 | Set `true` only behind a trusted reverse proxy      |
| `DATABASE_URL`              | yes      | —                       | PostgreSQL (with PostGIS) connection string         |
| `REDIS_URL`                 | yes      | —                       | Redis connection string (`redis://` or `rediss://`) |
| `LOG_LEVEL`                 | no       | `info`                  | `fatal` … `trace`, or `silent`                      |
| `OPENAPI_ENABLED`           | no       | on except in production | Serve Swagger UI at `/api/docs`                     |
| `RATE_LIMIT_WINDOW_SECONDS` | no       | `60`                    | Global rate-limit window                            |
| `RATE_LIMIT_MAX_REQUESTS`   | no       | `300`                   | Requests allowed per client per window              |
| `HEALTH_CHECK_TIMEOUT_MS`   | no       | `2000`                  | Timeout per dependency in the readiness check       |

| `SESSION_COOKIE_SECURE` | no | on in staging/production | HTTPS-only session cookie |
| `MFA_ENCRYPTION_KEY` | yes | — | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts two-factor secrets. The `.env.example` value is a public placeholder and is rejected in staging/production. |
| `EMAIL_PROVIDER` | no | `smtp` | `smtp` (Mailpit locally) or `resend` |
| `EMAIL_FROM` | yes | — | Sender, e.g. `"CivicEye <no-reply@your-domain>"` (quote it) |
| `SMTP_URL` | when `smtp` | — | e.g. `smtp://127.0.0.1:1025` for Mailpit |
| `RESEND_API_KEY` | when `resend` | — | From the Resend dashboard. Sending to real users needs a domain verified in Resend. |

| `STORAGE_ENDPOINT` | yes | — | S3-compatible endpoint (`http://127.0.0.1:8333` locally; the R2 account endpoint in staging/production) |
| `STORAGE_REGION` | no | `auto` | Region (R2 uses `auto`) |
| `STORAGE_BUCKET` | yes | — | Bucket for report photos |
| `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` | yes | — | Storage credentials (local values are in `docker/seaweedfs/s3.json`) |
| `STORAGE_FORCE_PATH_STYLE` | no | `false` | `true` for local SeaweedFS |
| `STORAGE_CREATE_BUCKET` | no | `false` | Create the bucket and its CORS rule at startup; development/test only (rejected in staging/production) |
| `RUN_WORKERS` | no | `false` | Run background jobs (photo processing) inside this process |

Variables for maps and the AI service are added in the phases that need them.

## Accounts and access control

- **Sessions** are server-managed: the browser holds an opaque random token in an `HttpOnly`,
  `SameSite=Lax` cookie; Redis stores the session under a SHA-256 hash of that token, and
  PostgreSQL keeps metadata so users can see and sign out their devices. Lifetimes: citizens
  7 days (24 h idle), Super Admins 12 hours (30 min idle). If Redis is unavailable, sign-in and
  session checks fail closed.
- **CSRF**: state-changing requests must send the `x-csrf-token` header (returned by
  `POST /auth/login` and `GET /auth/me`) and come from an allowed origin. The web app and API must
  be served from the same site (e.g. `example.org` and `api.example.org`) for cookies to work.
- **Permissions**: every route must declare `@Public()` or `@RequirePermissions(...)`; the API
  refuses to start otherwise. Role→permission maps are in
  [`src/modules/access/permissions.ts`](src/modules/access/permissions.ts). Organization
  permissions come only from an active membership in that organization, never from a platform role.
- **Passwords**: Argon2id; 12–128 characters, not common or containing the user's name/email.
- **Two-factor**: TOTP authenticator apps plus 10 one-time backup codes; required for Super Admins.
- **Account enumeration**: register and forgot-password respond identically for known and
  unknown emails; login gives the same error for a wrong password and an unknown email.
- **Emails** (verification, reset, notices) are sent in the background; links carry tokens in the
  URL fragment, which browsers never send to servers. Reliable retries arrive with the
  notification outbox in Phase 7.
- **Audit log**: security events are written to `audit_logs`, which a database trigger makes
  append-only.
- **First admin**: there is no public way to become an administrator. Run `npm run admin:create`
  on a machine with database access; two-factor setup is enforced at first sign-in.

## Organizations

- **Creation and verification** (Super Admin only): an organization is created with its official
  government email domain (`*.gov.bd`). A named contact on that domain confirms through a
  single-use email link; only then can a Super Admin approve. Decisions are kept in an
  append-only history and the audit log. Suspending an organization removes members' access.
- **Roles**: Org Admin (profile, members, categories), Reviewer (reviews reports and verifies
  work) and Worker. Access comes only from an active membership; other organizations — and Super
  Admins without a membership — get `NOT_FOUND`. The last Org Admin cannot be removed or demoted.
- **Invitations** are single-use, expire after 7 days, and can only be accepted by the invited,
  verified email address.
- **Service areas** are uploaded by Super Admins as GeoJSON (Polygon/MultiPolygon, WGS84, at most
  5 MB, 50,000 points, 10,000 km²). Invalid shapes are rejected, never repaired. Overlaps between
  organizations are reported, not resolved (policy still open). `POST /locations/organization-match`
  returns verified organizations covering a point. All geometry is EPSG:4326; areas are computed on
  the ellipsoid.
- **Categories** from PRD §5.3 are seeded (Bangla names need native-speaker review) and managed by
  Super Admins; at most two levels deep.

## Reports and photos

- Photos go straight from the browser to storage through a short-lived (5 minute) signed URL.
  The **worker** (`npm run worker`, or `RUN_WORKERS=true` in the API process) checks each photo
  by its content, re-encodes it without metadata (GPS included), makes a thumbnail and deletes
  the original. Run the worker alongside the API, or photos stay "checking".
- Submitting needs a verified email and an `Idempotency-Key` header; repeating a key returns the
  same report. Edits need `If-Match: <version>`; a stale version gets `409`, none gets `428`.
- Status changes go through one transition table (`report-transitions.ts`); status history and
  edits are append-only in the database.
- Public responses never include the reporter and round locations to 3 decimals (about 100 m).
- In staging/production (Cloudflare R2), add a bucket CORS rule allowing `PUT` and `GET` from the
  web origin with the `Content-Type` header.

## API conventions

- Base path `/api/v1`. Every response uses the standard envelope:
  `{ success: true, data, meta: { requestId } }` or
  `{ success: false, error: { code, message, details, requestId } }`.
- Error `code` values are stable and listed in
  [`src/common/errors/error-codes.ts`](src/common/errors/error-codes.ts). Only deliberate
  `AppException` messages reach clients; unexpected errors return `INTERNAL_ERROR` with no internals.
- Every response carries an `x-request-id` header, also written to every log line.
- Request bodies, queries and path parameters are validated with Zod via `ZodValidationPipe`.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs formatting, lint, type checks, unit
tests, the build, an OpenAPI freshness check and a production dependency audit, plus the
integration tests against real PostGIS and Redis (including migrations and a schema-drift check).
