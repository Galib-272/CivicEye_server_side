import { Module } from '@nestjs/common';
import {
  MyDashboardsController,
  OrganizationAnalyticsController,
  PlatformAnalyticsController,
} from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  controllers: [
    MyDashboardsController,
    OrganizationAnalyticsController,
    PlatformAnalyticsController,
  ],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
