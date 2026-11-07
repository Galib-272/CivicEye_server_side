import type { Config } from 'jest';

const config: Config = {
  rootDir: '.',
  // node_modules links to .deps.nosync/node_modules, which iCloud does not sync.
  modulePathIgnorePatterns: ['<rootDir>/.deps.nosync/', '<rootDir>/ml/', '<rootDir>/dist/'],
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts', '!src/generated/**', '!src/main.ts'],
  coverageDirectory: 'coverage/unit',
};

export default config;
