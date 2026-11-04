import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { AccessService } from '../access/access.service';
import type { OrganizationPermission, Permission } from '../access/permissions';
import { AUTH_USER_SELECT, SIGN_IN_ALLOWED_STATUSES } from './auth-context';
import {
  ALLOW_INCOMPLETE_MFA,
  IS_PUBLIC,
  ORGANIZATION_PERMISSION,
  REQUIRED_PERMISSIONS,
} from './auth.decorators';
import { constantTimeEquals } from './crypto';
import { SessionService } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Global guard, applied to every route. In order:
 * 1. Cross-site protection for state-changing requests (Origin / Sec-Fetch-Site checks).
 * 2. Resolves the session cookie and reloads the user, ending sessions of inactive accounts.
 * 3. Public routes stop here.
 * 4. Otherwise requires a session, a valid CSRF token on state-changing requests, completed
 *    two-factor verification, every permission the route declares and, for organization
 *    routes, an active membership whose role grants the organization permission.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const targets = [context.getHandler(), context.getClass()];
    const unsafe = !SAFE_METHODS.has(request.method);

    if (unsafe) this.assertSameSiteRequest(request);
    await this.attachSession(request);

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) {
      return true;
    }

    const auth = request.auth;
    if (!auth) throw new AppException(ErrorCode.UNAUTHENTICATED);

    if (unsafe) {
      const header = request.headers[CSRF_HEADER];
      const supplied = Array.isArray(header) ? header[0] : header;
      if (!supplied || !constantTimeEquals(supplied, auth.session.csrfToken)) {
        throw new AppException(ErrorCode.CSRF_TOKEN_INVALID);
      }
    }

    const mfaIncomplete = auth.session.mfa === 'pending' || auth.session.mfa === 'setup_required';
    if (
      mfaIncomplete &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_INCOMPLETE_MFA, targets)
    ) {
      throw new AppException(ErrorCode.MFA_REQUIRED);
    }

    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, targets);
    if (!required || required.length === 0) {
      // Unreachable while RouteDeclarationCheck runs at startup; deny by default regardless.
      throw new AppException(ErrorCode.FORBIDDEN);
    }
    const decision = this.access.checkPlatformPermissions(auth.user, required);
    if (!decision.allowed) {
      throw new AppException(
        decision.reason === 'email_not_verified'
          ? ErrorCode.EMAIL_NOT_VERIFIED
          : ErrorCode.FORBIDDEN,
      );
    }

    const organizationPermission = this.reflector.getAllAndOverride<OrganizationPermission>(
      ORGANIZATION_PERMISSION,
      targets,
    );
    if (organizationPermission) {
      const organizationId = request.params['organizationId'];
      const allowed =
        typeof organizationId === 'string' &&
        UUID.test(organizationId) &&
        (await this.access.hasOrganizationPermission(
          auth.user.id,
          organizationId,
          organizationPermission,
        ));
      if (!allowed) throw new AppException(ErrorCode.NOT_FOUND);
    }
    return true;
  }

  /** Rejects state-changing requests that a browser marks as coming from another site. */
  private assertSameSiteRequest(request: Request): void {
    const origin = request.headers.origin;
    if (origin !== undefined && !this.config.corsOrigins.includes(origin)) {
      throw new AppException(ErrorCode.FORBIDDEN);
    }
    if (request.headers['sec-fetch-site'] === 'cross-site' && origin === undefined) {
      throw new AppException(ErrorCode.FORBIDDEN);
    }
  }

  private async attachSession(request: Request): Promise<void> {
    const cookies = request.cookies as Record<string, string | undefined> | undefined;
    const token = cookies?.[this.sessions.cookieName()];
    if (!token) return;

    const session = await this.sessions.resolve(token);
    if (!session) return;

    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      select: AUTH_USER_SELECT,
    });
    if (!user || !SIGN_IN_ALLOWED_STATUSES.has(user.status)) {
      await this.sessions.revoke(session.sessionId, 'account_status_changed');
      return;
    }
    request.auth = { user, session, token };
  }
}
