import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { IdempotencyService } from './idempotency.service';
import { AdminReportsController, ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [MediaModule, OrganizationsModule],
  controllers: [ReportsController, AdminReportsController],
  providers: [ReportsService, IdempotencyService],
})
export class ReportsModule {}
