import { Inject, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayInit,
} from '@nestjs/websockets';
import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Server, Socket } from 'socket.io';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { createRedisClient, REDIS_CLIENT } from '../../redis/redis.module';
import { REALTIME_CHANNEL, type RealtimeMessage } from './realtime.publisher';

const TICKET_TTL_SECONDS = 60;
const ticketKey = (ticket: string) =>
  `realtime:ticket:${createHash('sha256').update(ticket).digest('hex')}`;

/** Issues one-time, 60-second tickets that open a live connection for the signed-in user. */
export async function issueRealtimeTicket(redis: Redis, userId: string): Promise<string> {
  const ticket = randomBytes(32).toString('base64url');
  await redis.set(ticketKey(ticket), userId, 'EX', TICKET_TTL_SECONDS);
  return ticket;
}

/**
 * Live updates over Socket.IO. A browser first gets a one-time ticket from the API (with its
 * session cookie), then connects with it, so no cookie needs to cross sites. Each connection
 * joins only "user:<id>" and "org:<id>" for organizations where the user is an active Org Admin
 * or Reviewer. Messages contain no data; the browser re-fetches through the authorized API.
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private subscriber: Redis | undefined;
  @WebSocketServer() private server!: Server;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
  ) {}

  /** Runs only where an HTTP server exists (the API), never in background workers. */
  afterInit(): void {
    this.subscriber = createRedisClient(this.config);
    this.subscriber.on('message', (_channel: string, raw: string) => {
      try {
        const message = JSON.parse(raw) as RealtimeMessage;
        for (const room of message.rooms) this.server.to(room).emit(message.event);
      } catch (error) {
        this.logger.warn({ err: error }, 'Ignored a malformed live update');
      }
    });
    void this.subscriber
      .subscribe(REALTIME_CHANNEL)
      .catch((error: unknown) => this.logger.error({ err: error }, 'Live updates unavailable'));
  }

  async handleConnection(socket: Socket): Promise<void> {
    const auth = socket.handshake.auth as { ticket?: unknown } | undefined;
    const ticket = typeof auth?.ticket === 'string' ? auth.ticket : null;
    const userId = ticket ? await this.redis.getdel(ticketKey(ticket)).catch(() => null) : null;
    if (!userId) {
      socket.emit('unauthorized');
      socket.disconnect(true);
      return;
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        memberships: {
          where: {
            status: 'ACTIVE',
            role: { in: ['ORG_ADMIN', 'ORG_REVIEWER'] },
            organization: { isActive: true },
          },
          select: { organizationId: true },
        },
      },
    });
    if (!user || user.status !== 'ACTIVE') {
      socket.disconnect(true);
      return;
    }
    await socket.join([
      `user:${userId}`,
      ...user.memberships.map((membership) => `org:${membership.organizationId}`),
    ]);
    socket.emit('ready');
  }

  onModuleDestroy(): void {
    this.subscriber?.disconnect();
  }
}
