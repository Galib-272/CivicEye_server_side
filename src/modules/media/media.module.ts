import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { bullmqConnection, defaultJobOptions } from '../../jobs/queue-connection';
import { MediaProcessingWorker } from './media-processing.worker';
import { MediaController } from './media.controller';
import { MEDIA_QUEUE, MEDIA_QUEUE_NAME, MediaService } from './media.service';

@Module({
  controllers: [MediaController],
  providers: [
    MediaService,
    MediaProcessingWorker,
    {
      provide: MEDIA_QUEUE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new Queue(MEDIA_QUEUE_NAME, {
          connection: bullmqConnection(config),
          defaultJobOptions,
        }),
    },
  ],
  exports: [MediaService],
})
export class MediaModule implements OnModuleDestroy {
  constructor(@Inject(MEDIA_QUEUE) private readonly queue: Queue) {}

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
