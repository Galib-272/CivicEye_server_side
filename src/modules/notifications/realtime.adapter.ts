import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server, ServerOptions } from 'socket.io';
import type { AppConfig } from '../../config/app-config';

/** Socket.IO with the same allowed origins as the HTTP API. No cookies: tickets authenticate. */
export class ConfiguredIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly config: AppConfig,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const configured: Partial<ServerOptions> = {
      ...options,
      path: '/socket.io',
      cors: { origin: this.config.corsOrigins, credentials: false },
      serveClient: false,
    };
    return super.createIOServer(port, configured as ServerOptions);
  }
}
