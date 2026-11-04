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
import { MEDIA_QUEUE_NAME, MediaService } from './media.service';

/**
 * Processes uploaded photos. Runs only in processes started with RUN_WORKERS=true (the worker
 * entry point), so slow image work never blocks API requests.
 */
@Injectable()
export class MediaProcessingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaProcessingWorker.name);
  private worker: Worker | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly media: MediaService,
  ) {}

  onModuleInit(): void {
    if (!this.config.runWorkers) return;
    this.worker = new Worker<{ mediaId: string }>(
      MEDIA_QUEUE_NAME,
      async (job) => this.media.process(job.data.mediaId),
      { connection: bullmqConnection(this.config), concurrency: 2 },
    );
    this.worker.on('failed', (job, error) =>
      this.logger.error(
        { err: error, jobId: job?.id, attempts: job?.attemptsMade },
        'Photo processing failed',
      ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
