import { Controller, Get, Module, Post } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Public } from './auth.decorators';
import { RouteDeclarationCheck } from './route-declaration.check';

@Controller({ path: 'things', version: '1' })
class FirstController {
  @Post('match')
  @Public()
  match() {
    return [];
  }
}

@Controller({ version: '1' })
class SecondController {
  @Post('things/match')
  @Public()
  match() {
    return {};
  }
}

@Controller({ path: 'things', version: '1' })
class UndeclaredController {
  @Get()
  list() {
    return [];
  }
}

async function boot(controllers: Array<new () => unknown>) {
  @Module({ imports: [DiscoveryModule], controllers, providers: [RouteDeclarationCheck] })
  class TestModule {}
  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  try {
    await app.init();
  } finally {
    await app.close();
  }
}

describe('RouteDeclarationCheck', () => {
  it('refuses two handlers for the same method and path', async () => {
    await expect(boot([FirstController, SecondController])).rejects.toThrow(
      /Routes declared twice: POST v1 \/things\/match \(FirstController.match and SecondController.match\)/,
    );
  });

  it('refuses routes without @Public() or @RequirePermissions()', async () => {
    await expect(boot([UndeclaredController])).rejects.toThrow(/UndeclaredController.list/);
  });

  it('accepts distinct, declared routes', async () => {
    await expect(boot([FirstController])).resolves.toBeUndefined();
  });
});
