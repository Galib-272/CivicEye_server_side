import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { IS_PUBLIC, REQUIRED_PERMISSIONS } from './auth.decorators';

/**
 * Deny by default, enforced at startup: the application refuses to start if any route declares
 * neither @Public() nor @RequirePermissions(). A forgotten decorator can therefore never ship
 * as an accidentally open endpoint.
 */
@Injectable()
export class RouteDeclarationCheck implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const undeclared: string[] = [];

    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as object | undefined;
      const metatype = wrapper.metatype;
      if (!instance || !metatype) continue;
      const prototype = Object.getPrototypeOf(instance) as object;
      const controllerName = typeof metatype === 'function' ? metatype.name : 'UnknownController';

      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[methodName];
        if (typeof handler !== 'function') continue;
        if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;

        const targets = [handler, metatype];
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
        const permissions = this.reflector.getAllAndOverride<string[]>(
          REQUIRED_PERMISSIONS,
          targets,
        );
        if (!isPublic && !permissions?.length) {
          undeclared.push(`${controllerName}.${methodName}`);
        }
      }
    }

    if (undeclared.length > 0) {
      throw new Error(
        `Routes must declare @Public() or @RequirePermissions(): ${undeclared.join(', ')}`,
      );
    }
  }
}
