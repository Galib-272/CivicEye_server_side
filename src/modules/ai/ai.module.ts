import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { bullmqConnection, defaultJobOptions } from '../../jobs/queue-connection';
import { AdminAiController, OrganizationAiController } from './ai.controller';
import { AI_QUEUE, AI_QUEUE_NAME, AiService } from './ai.service';
import { AiWorker } from './ai.worker';

@Module({
  controllers: [OrganizationAiController, AdminAiController],
  providers: [
    AiService,
    AiWorker,
    {
      provide: AI_QUEUE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new Queue(AI_QUEUE_NAME, { connection: bullmqConnection(config), defaultJobOptions }),
    },
  ],
  exports: [AiService],
})
export class AiModule implements OnModuleDestroy {
  constructor(@Inject(AI_QUEUE) private readonly queue: Queue) {}

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
