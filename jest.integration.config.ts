import type { Config } from 'jest';

// Integration tests start real PostGIS and Redis containers through Testcontainers,
// so they need a running Docker daemon.
const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/integration/**/*.int-spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 180_000,
};

export default config;
