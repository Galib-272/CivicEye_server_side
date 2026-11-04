import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { getRequestId } from '../../common/http/request-id';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

export interface AuditEntry {
  action: string;
  result: 'SUCCESS' | 'FAILURE';
  actorUserId?: string | null;
  targetType?: string;
  targetId?: string;
  reason?: string;
  /** Never include passwords, tokens, codes or other secrets. */
  metadata?: Prisma.InputJsonValue;
}

type AuditClient = Pick<PrismaService, 'auditLog'>;

/** Writes to the append-only audit log (PRD §26.7). */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records an audit event. Pass a transaction client to make the audit entry part of the same
   * transaction as the change it describes.
   */
  async record(entry: AuditEntry, request?: Request, client: AuditClient = this.prisma) {
    await client.auditLog.create({
      data: {
        action: entry.action,
        result: entry.result,
        actorUserId: entry.actorUserId ?? null,
        targetType: entry.targetType,
        targetId: entry.targetId,
        reason: entry.reason?.slice(0, 1000),
        metadata: entry.metadata,
        requestId: request ? getRequestId(request) : undefined,
        ipAddress: request?.ip?.slice(0, 45),
      },
    });
  }

  /**
   * For events outside a transaction where failing the request would be worse than a missing
   * entry (e.g. a failed login attempt). Failures are logged loudly.
   */
  async recordBestEffort(entry: AuditEntry, request?: Request): Promise<void> {
    await this.record(entry, request).catch((error: unknown) =>
      this.logger.error({ err: error, action: entry.action }, 'Failed to write audit log entry'),
    );
  }
}
