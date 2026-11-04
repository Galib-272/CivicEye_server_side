import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../database/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';

export type ComponentStatus = 'up' | 'down';

export interface ReadinessReport {
  ready: boolean;
  checks: { database: ComponentStatus; redis: ComponentStatus };
}

class CheckTimeoutError extends Error {}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const [database, redis] = await Promise.all([
      this.check('database', () => this.prisma.ping()),
      this.check('redis', () => this.pingRedis()),
    ]);
    return { ready: database === 'up' && redis === 'up', checks: { database, redis } };
  }

  private async pingRedis(): Promise<void> {
    if (this.redis.status === 'wait' || this.redis.status === 'end') {
      await this.redis.connect();
    }
    await this.redis.ping();
  }

  /** Runs one dependency check with a timeout. Failure details go to logs, never to the response. */
  private async check(name: string, probe: () => Promise<void>): Promise<ComponentStatus> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CheckTimeoutError()), this.config.healthCheckTimeoutMs);
    });
    try {
      await Promise.race([probe(), timeout]);
      return 'up';
    } catch (error) {
      this.logger.warn(
        {
          component: name,
          reason: error instanceof CheckTimeoutError ? 'timeout' : 'error',
          err: error,
        },
        'Readiness check failed',
      );
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
