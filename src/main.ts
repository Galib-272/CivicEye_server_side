import 'reflect-metadata';
import { createApp } from './app.factory';
import { ConfigValidationError, loadConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port);
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet (e.g. invalid configuration), so write directly to stderr.
  const message = error instanceof ConfigValidationError ? error.message : 'API failed to start';
  process.stderr.write(`${message}\n`);
  if (!(error instanceof ConfigValidationError) && error instanceof Error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
  }
  process.exit(1);
});
