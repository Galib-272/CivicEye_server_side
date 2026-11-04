import { Module } from '@nestjs/common';
import { CategoriesModule } from '../categories/categories.module';
import { ServiceAreasService } from '../service-areas/service-areas.service';
import { AdminOrganizationsController } from './admin-organizations.controller';
import { MembershipsService } from './memberships.service';
import {
  OrganizationEnrollmentController,
  OrganizationsController,
} from './organizations.controller';
import { OrganizationsService } from './organizations.service';

@Module({
  imports: [CategoriesModule],
  controllers: [
    AdminOrganizationsController,
    OrganizationEnrollmentController,
    OrganizationsController,
  ],
  providers: [OrganizationsService, MembershipsService, ServiceAreasService],
  exports: [ServiceAreasService],
})
export class OrganizationsModule {}
