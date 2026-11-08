import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { bullmqConnection } from '../../jobs/queue-connection';
import { AiServiceError } from './ai-client';
import { AI_JOB_ATTEMPTS, AI_QUEUE_NAME, AiService } from './ai.service';

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Sends report photos to the AI service, one at a time (the service is CPU-bound). Runs only in
 * processes with RUN_WORKERS=true. After the last attempt the analysis is marked FAILED; the
 * report is never affected.
 */
@Injectable()
export class AiWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiWorker.name);
  private worker: Worker | undefined;
  private sweep: NodeJS.Timeout | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly ai: AiService,
  ) {}

  onModuleInit(): void {
    if (!this.config.runWorkers) return;
    this.worker = new Worker<{ predictionId: string }>(
      AI_QUEUE_NAME,
      async (job) => this.ai.process(job.data.predictionId),
      { connection: bullmqConnection(this.config), concurrency: 1 },
    );
    this.worker.on('failed', (job, error) => {
      if (!job) return;
      const { predictionId } = job.data as { predictionId: string };
      const final = job.attemptsMade >= (job.opts.attempts ?? AI_JOB_ATTEMPTS);
      this.logger.warn(
        { predictionId, attempts: job.attemptsMade, final, err: error },
        'AI analysis attempt failed',
      );
      if (final) {
        const code = error instanceof AiServiceError ? error.code : 'internal_error';
        void this.ai
          .markFailed(predictionId, code)
          .catch((cause: unknown) =>
            this.logger.error({ err: cause }, 'Could not record AI failure'),
          );
      }
    });
    this.sweep = setInterval(() => {
      void this.ai
        .requeueStale()
        .catch((error: unknown) => this.logger.error({ err: error }, 'AI sweep failed'));
    }, SWEEP_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweep) clearInterval(this.sweep);
    await this.worker?.close();
  }
}
