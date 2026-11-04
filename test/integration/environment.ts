import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { GenericContainer } from 'testcontainers';
import { loadConfig, type AppConfig } from '../../src/config/app-config';

// Keep in sync with docker-compose.yml. The PostGIS image is built from the project's
// Dockerfile so it runs natively on both amd64 (CI) and arm64 (Apple silicon).
export const POSTGIS_IMAGE = 'civiceye-postgis:17';
export const REDIS_IMAGE = 'redis:7.4-alpine';

const SERVER_ROOT = resolve(__dirname, '../..');

let postgisImageBuilt: Promise<unknown> | undefined;

function buildPostgisImage(): Promise<unknown> {
  postgisImageBuilt ??= GenericContainer.fromDockerfile(
    resolve(SERVER_ROOT, 'docker/postgis'),
  ).build(POSTGIS_IMAGE, { deleteOnExit: false });
  return postgisImageBuilt;
}

export interface TestEnvironment {
  postgres: StartedPostgreSqlContainer;
  redis: StartedRedisContainer;
  databaseUrl: string;
  redisUrl: string;
  config(overrides?: Partial<AppConfig>): AppConfig;
  stop(): Promise<void>;
}

export async function startEnvironment(): Promise<TestEnvironment> {
  await buildPostgisImage();
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer(POSTGIS_IMAGE).start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);
  const databaseUrl = postgres.getConnectionUri();
  const redisUrl = redis.getConnectionUrl();

  return {
    postgres,
    redis,
    databaseUrl,
    redisUrl,
    config: (overrides = {}) => ({
      ...loadConfig({
        NODE_ENV: 'test',
        WEB_URL: 'http://localhost:3000',
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        LOG_LEVEL: 'silent',
        HEALTH_CHECK_TIMEOUT_MS: '1000',
        MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        EMAIL_FROM: 'CivicEye <test@example.test>',
        SMTP_URL: 'smtp://127.0.0.1:1025',
      }),
      ...overrides,
    }),
    stop: async () => {
      await Promise.allSettled([postgres.stop(), redis.stop()]);
    },
  };
}

/** Runs the Prisma CLI against the test database, exactly as deployments do. */
export function prisma(args: string[], databaseUrl: string): { status: number; output: string } {
  try {
    const output = execFileSync('npx', ['prisma', ...args], {
      cwd: SERVER_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}
