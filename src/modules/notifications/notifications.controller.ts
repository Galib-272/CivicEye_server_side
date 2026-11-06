import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { ApiErrorResponses } from '../../common/http/openapi';
import {
  ApiZodBody,
  ApiZodPaginatedResponse,
  ApiZodQuery,
  ApiZodResponse,
} from '../../common/http/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { Permission } from '../access/permissions';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../auth/auth.decorators';
import {
  deliveryHealthSchema,
  notificationSchema,
  notificationsQuerySchema,
  preferencesInputSchema,
  preferencesSchema,
  ticketSchema,
  unreadCountSchema,
  type NotificationsQuery,
  type PreferencesInput,
} from './notifications.schemas';
import { NotificationsService } from './notifications.service';
import { issueRealtimeTicket } from './realtime.gateway';

const uuid = new ZodValidationPipe(z.uuid());

/** The signed-in user's own notifications. Nobody can read or change anyone else's. */
@ApiTags('notifications')
@Controller({ path: 'notifications', version: '1' })
@RequirePermissions(Permission.AccountSelf)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Your notifications, newest first.' })
  @ApiZodQuery(notificationsQuerySchema)
  @ApiZodPaginatedResponse(notificationSchema)
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(notificationsQuerySchema)) query: NotificationsQuery,
  ) {
    return this.notifications.list(auth.user.id, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'How many of your notifications are unread.' })
  @ApiZodResponse(unreadCountSchema)
  unreadCount(@CurrentAuth() auth: AuthContext) {
    return this.notifications.unreadCount(auth.user.id);
  }

  @Patch(':notificationId/read')
  @ApiOperation({ summary: 'Mark one notification as read.' })
  @ApiZodResponse(unreadCountSchema)
  @ApiErrorResponses(404)
  markRead(@CurrentAuth() auth: AuthContext, @Param('notificationId', uuid) id: string) {
    return this.notifications.markRead(auth.user.id, id);
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark all your notifications as read.' })
  @ApiZodResponse(unreadCountSchema)
  markAllRead(@CurrentAuth() auth: AuthContext) {
    return this.notifications.markAllRead(auth.user.id);
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Your email choices.' })
  @ApiZodResponse(preferencesSchema)
  preferences(@CurrentAuth() auth: AuthContext) {
    return this.notifications.preferences(auth.user.id);
  }

  @Put('preferences')
  @ApiOperation({
    summary: 'Turn emails on or off for your reports, your tasks and your organizations.',
  })
  @ApiZodBody(preferencesInputSchema)
  @ApiZodResponse(preferencesSchema)
  @ApiErrorResponses(400)
  setPreferences(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(preferencesInputSchema)) input: PreferencesInput,
  ) {
    return this.notifications.setPreferences(auth.user.id, input);
  }

  @Post('realtime-ticket')
  @HttpCode(200)
  @ApiOperation({
    summary: 'A one-time ticket (valid 60 seconds) for opening the live-updates connection.',
  })
  @ApiZodResponse(ticketSchema)
  async ticket(@CurrentAuth() auth: AuthContext) {
    return { ticket: await issueRealtimeTicket(this.redis, auth.user.id), expiresInSeconds: 60 };
  }
}

/** Super Admin view of event and email delivery, with manual retries. */
@ApiTags('admin')
@Controller({ path: 'admin/delivery-health', version: '1' })
@RequirePermissions(Permission.AdminDeliveryManage)
export class DeliveryHealthController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Waiting and failed events, and emails that could not be delivered.' })
  @ApiZodResponse(deliveryHealthSchema)
  health() {
    return this.notifications.health();
  }

  @Post('events/:eventId/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Retry a failed event.' })
  @ApiZodResponse(z.object({ queued: z.literal(true) }))
  @ApiErrorResponses(404)
  async retryEvent(@Param('eventId', uuid) id: string) {
    await this.notifications.retryEvent(id);
    return { queued: true as const };
  }

  @Post('emails/:notificationId/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a failed notification email again.' })
  @ApiZodResponse(z.object({ queued: z.literal(true) }))
  @ApiErrorResponses(404)
  async retryEmail(@Param('notificationId', uuid) id: string) {
    await this.notifications.retryEmail(id);
    return { queued: true as const };
  }
}
