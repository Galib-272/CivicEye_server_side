import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { createEmailTransport, EMAIL_TRANSPORT, EmailService } from './email.service';

@Global()
@Module({
  providers: [
    EmailService,
    {
      provide: EMAIL_TRANSPORT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createEmailTransport(config),
    },
  ],
  exports: [EmailService],
})
export class EmailModule {}
