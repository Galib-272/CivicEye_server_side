import type { Config } from 'jest';

const config: Config = {
  rootDir: '.',
  // Never scan the ML workspace or build output for modules.
  modulePathIgnorePatterns: ['<rootDir>/ml/', '<rootDir>/dist/'],
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts', '!src/generated/**', '!src/main.ts'],
  coverageDirectory: 'coverage/unit',
};

export default config;
