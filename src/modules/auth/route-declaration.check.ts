import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { IS_PUBLIC, REQUIRED_PERMISSIONS } from './auth.decorators';

/**
 * Deny by default, enforced at startup: the application refuses to start if any route declares
 * neither @Public() nor @RequirePermissions(). A forgotten decorator can therefore never ship
 * as an accidentally open endpoint. It also refuses two handlers for the same method and path,
 * where the second would silently never run.
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
    const seen = new Map<string, string>();
    const clashes: string[] = [];

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

        const route = routeKey(metatype, handler);
        const owner = `${controllerName}.${methodName}`;
        const first = seen.get(route);
        if (first) clashes.push(`${route} (${first} and ${owner})`);
        else seen.set(route, owner);
      }
    }

    if (clashes.length > 0) {
      throw new Error(`Routes declared twice: ${clashes.join(', ')}`);
    }
    if (undeclared.length > 0) {
      throw new Error(
        `Routes must declare @Public() or @RequirePermissions(): ${undeclared.join(', ')}`,
      );
    }
  }
}

/** "POST /locations/organization-match" for a handler, from its controller and method paths. */
function routeKey(controller: unknown, handler: object): string {
  const join = (value: unknown) =>
    (Array.isArray(value) ? value : [value ?? '']).map((part) => String(part)).join('|');
  const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
  const base = join(Reflect.getMetadata(PATH_METADATA, controller as object));
  const path = join(Reflect.getMetadata(PATH_METADATA, handler));
  const full = `/${base}/${path}`.replace(/\/+/g, '/').replace(/\/$/, '');
  const version = join(
    Reflect.getMetadata(VERSION_METADATA, handler) ??
      Reflect.getMetadata(VERSION_METADATA, controller as object),
  );
  return `${RequestMethod[method ?? RequestMethod.GET]} v${version} ${full || '/'}`;
}
