import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { IdempotencyService } from './idempotency.service';
import { AdminReportsController, ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import {
  AdminReportModerationController,
  OrganizationReportsController,
} from './review.controller';
import { ReviewService } from './review.service';

@Module({
  imports: [MediaModule, OrganizationsModule],
  // AdminReportsController first: its fixed "triage" path must win over ":publicId".
  controllers: [
    ReportsController,
    AdminReportsController,
    AdminReportModerationController,
    OrganizationReportsController,
  ],
  providers: [ReportsService, ReviewService, IdempotencyService],
})
export class ReportsModule {}
