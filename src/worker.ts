import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ConfigValidationError, loadConfig } from './config/app-config';

/**
 * Background worker: the same application modules without an HTTP server, with job
 * processors enabled. Run one or more of these next to the API.
 */
async function bootstrap(): Promise<void> {
  const config = { ...loadConfig(), runWorkers: true };
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.get(Logger).log('Worker started');
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof ConfigValidationError ? error.message : 'Worker failed to start';
  process.stderr.write(`${message}\n`);
  if (!(error instanceof ConfigValidationError) && error instanceof Error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
  }
  process.exit(1);
});
