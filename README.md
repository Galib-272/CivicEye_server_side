# CivicEye — server

Backend for **CivicEye**, a civic issue reporting, tracking and resolution platform. Citizens
report problems such as potholes or broken streetlights, the responsible organization reviews and
repairs them, and an authorized person verifies the work.

The web app lives in a separate repository: [CivicEye_client_side](https://github.com/Galib-272/CivicEye_client_side).

> **Status: Phase 1 (project foundation).** There are no product features yet: no accounts,
> reports, maps or AI. See the [decision register](docs/decision-register.md) for what is
> decided and what is still open.

## Stack

NestJS (modular monolith) · TypeScript · PostgreSQL 17 + PostGIS 3 via Prisma · Redis ·
BullMQ · OpenAPI. The internal AI service ([`ai-services/`](ai-services)) and ML work
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
```

- API: <http://localhost:4000>
- API docs: <http://localhost:4000/api/docs>
- Readiness: <http://localhost:4000/api/v1/health/ready>
- Development mail (Mailpit, used from Phase 2): <http://localhost:8025>

## Commands

| Task                             | Command                                   |
| -------------------------------- | ----------------------------------------- |
| Develop (watch mode)             | `npm run dev`                             |
| Lint / format check              | `npm run lint` / `npm run format:check`   |
| Type check                       | `npm run typecheck`                       |
| Unit tests                       | `npm test`                                |
| Integration tests (needs Docker) | `npm run test:integration`                |
| Build / start                    | `npm run build` / `npm start`             |
| Apply migrations                 | `npm run db:migrate`                      |
| Create a migration               | `npm run db:migrate:dev -- --name <name>` |
| Export OpenAPI                   | `npm run openapi:export`                  |

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

Variables for sessions, storage, email, maps and the AI service are added in the phases that
need them.

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
