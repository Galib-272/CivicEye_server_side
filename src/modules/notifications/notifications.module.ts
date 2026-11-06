import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { bullmqConnection } from '../../jobs/queue-connection';
import { MaintenanceWorker } from './maintenance.worker';
import {
  NOTIFICATION_EMAIL_QUEUE,
  NOTIFICATION_EMAIL_QUEUE_NAME,
  NotificationDispatcher,
} from './notification-dispatcher.service';
import { NotificationEmailWorker } from './notification-email.worker';
import { DeliveryHealthController, NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimePublisher } from './realtime.publisher';

@Module({
  controllers: [NotificationsController, DeliveryHealthController],
  providers: [
    NotificationsService,
    NotificationDispatcher,
    NotificationEmailWorker,
    MaintenanceWorker,
    RealtimePublisher,
    RealtimeGateway,
    {
      provide: NOTIFICATION_EMAIL_QUEUE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new Queue(NOTIFICATION_EMAIL_QUEUE_NAME, {
          connection: bullmqConnection(config),
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 30_000 },
            removeOnComplete: { age: 24 * 3600, count: 1_000 },
            removeOnFail: { age: 7 * 24 * 3600 },
          },
        }),
    },
  ],
  exports: [NotificationDispatcher, MaintenanceWorker, NotificationEmailWorker],
})
export class NotificationsModule implements OnModuleDestroy {
  constructor(@Inject(NOTIFICATION_EMAIL_QUEUE) private readonly queue: Queue) {}

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
