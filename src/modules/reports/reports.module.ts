import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
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
import { AssignmentViews } from './assignment-views.service';
import {
  OrganizationWorkController,
  ReportFeedbackController,
  WorkController,
} from './work.controller';
import { WorkService } from './work.service';
import { DuplicatesService } from './duplicates.service';
import { MapController } from './map.controller';

@Module({
  imports: [AiModule, MediaModule, OrganizationsModule],
  // AdminReportsController first: its fixed "triage" path must win over ":publicId".
  controllers: [
    ReportsController,
    AdminReportsController,
    AdminReportModerationController,
    OrganizationReportsController,
    OrganizationWorkController,
    ReportFeedbackController,
    WorkController,
    MapController,
  ],
  providers: [
    ReportsService,
    ReviewService,
    WorkService,
    DuplicatesService,
    AssignmentViews,
    IdempotencyService,
  ],
})
export class ReportsModule {}
