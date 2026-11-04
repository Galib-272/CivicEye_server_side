import type { Response } from 'express';
import type { AuthenticatedUser } from './auth-context';
import type { AuthState } from './auth.schemas';
import type { SessionRecord, SessionService } from './session.service';

export function toSelfUser(user: AuthenticatedUser): AuthState['user'] {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    // Only these two states can hold a session (SIGN_IN_ALLOWED_STATUSES).
    status: user.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING_VERIFICATION',
    platformRole: user.platformRole,
    preferredLocale: user.preferredLocale,
    emailVerified: user.emailVerifiedAt !== null,
  };
}

export function toAuthState(user: AuthenticatedUser, session: SessionRecord): AuthState {
  return { user: toSelfUser(user), csrfToken: session.csrfToken, mfa: session.mfa };
}

export function setSessionCookie(
  response: Response,
  sessions: SessionService,
  token: string,
  record: SessionRecord,
  secure: boolean,
): void {
  response.cookie(sessions.cookieName(), token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.max(0, record.absoluteExpiresAt - Date.now()),
  });
}

export function clearSessionCookie(
  response: Response,
  sessions: SessionService,
  secure: boolean,
): void {
  response.clearCookie(sessions.cookieName(), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
  });
}
