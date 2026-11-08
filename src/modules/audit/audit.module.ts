import { Global, Module } from '@nestjs/common';
import { AdminAuditController, OrganizationAuditController } from './audit-views';
import { AuditService } from './audit.service';

@Global()
@Module({
  controllers: [AdminAuditController, OrganizationAuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
