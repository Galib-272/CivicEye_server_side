import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { ApiErrorResponses } from '../../common/http/openapi';
import { ApiZodBody, ApiZodResponse } from '../../common/http/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { Permission } from '../access/permissions';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth, Public, RequirePermissions } from '../auth/auth.decorators';
import {
  CategoriesService,
  categorySchema,
  createCategorySchema,
  updateCategorySchema,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from './categories.service';

@ApiTags('categories')
@Controller({ path: 'categories', version: '1' })
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Active issue categories, parents followed by their children.' })
  @ApiZodResponse(z.array(categorySchema))
  list() {
    return this.categories.listActive();
  }
}

@ApiTags('admin')
@Controller({ path: 'admin/categories', version: '1' })
@RequirePermissions(Permission.AdminCategoriesManage)
export class AdminCategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'All categories, including inactive ones (Super Admin).' })
  @ApiZodResponse(z.array(categorySchema))
  list() {
    return this.categories.listAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create a category (Super Admin).' })
  @ApiZodBody(createCategorySchema)
  @ApiZodResponse(categorySchema, 201)
  @ApiErrorResponses(400, 409)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createCategorySchema)) input: CreateCategoryInput,
    @Req() request: Request,
  ) {
    return this.categories.create(input, auth.user.id, request);
  }

  @Patch(':categoryId')
  @ApiOperation({ summary: 'Update or deactivate a category (Super Admin).' })
  @ApiZodBody(updateCategorySchema)
  @ApiZodResponse(categorySchema)
  @ApiErrorResponses(400, 404)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('categoryId', new ZodValidationPipe(z.uuid())) categoryId: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) input: UpdateCategoryInput,
    @Req() request: Request,
  ) {
    return this.categories.update(categoryId, input, auth.user.id, request);
  }
}
