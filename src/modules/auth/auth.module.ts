import { Global, Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { AuthRateLimiter } from './auth-rate-limiter.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { RouteDeclarationCheck } from './route-declaration.check';
import { SessionService } from './session.service';
import { SessionsController } from './sessions.controller';

@Global()
@Module({
  imports: [DiscoveryModule],
  controllers: [AuthController, MfaController, SessionsController],
  providers: [
    AuthService,
    MfaService,
    PasswordService,
    SessionService,
    AuthRateLimiter,
    RouteDeclarationCheck,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [PasswordService, SessionService, AuthRateLimiter],
})
export class AuthModule {}
