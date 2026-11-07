import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens.')
  .max(60);

export const createCategorySchema = z.strictObject({
  slug,
  parentId: z.uuid().nullable().optional(),
  nameEn: z.string().trim().min(2).max(100),
  nameBn: z.string().trim().min(2).max(100),
  descriptionEn: z.string().trim().max(500).nullable().optional(),
  descriptionBn: z.string().trim().max(500).nullable().optional(),
  displayOrder: z.number().int().min(0).max(10_000).optional(),
  /** Duplicate search radius in metres; null uses the parent's radius, then 50 m. */
  duplicateRadiusM: z.number().int().min(10).max(1000).nullable().optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = createCategorySchema
  .omit({ slug: true })
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.');
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const categorySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  parentId: z.uuid().nullable(),
  nameEn: z.string(),
  nameBn: z.string(),
  descriptionEn: z.string().nullable(),
  descriptionBn: z.string().nullable(),
  isActive: z.boolean(),
  displayOrder: z.number().int(),
  duplicateRadiusM: z.number().int().nullable(),
});
export type CategoryView = z.infer<typeof categorySchema>;

const CATEGORY_SELECT = {
  id: true,
  slug: true,
  parentId: true,
  nameEn: true,
  nameBn: true,
  descriptionEn: true,
  descriptionBn: true,
  isActive: true,
  displayOrder: true,
  duplicateRadiusM: true,
} as const;

/** Parents first, then their children, each ordered by display order and English name. */
function orderTree(categories: CategoryView[]): CategoryView[] {
  const byOrder = (a: CategoryView, b: CategoryView) =>
    a.displayOrder - b.displayOrder || a.nameEn.localeCompare(b.nameEn);
  const parents = categories.filter((category) => !category.parentId).sort(byOrder);
  return parents.flatMap((parent) => [
    parent,
    ...categories.filter((category) => category.parentId === parent.id).sort(byOrder),
  ]);
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Active categories whose parent (if any) is also active. */
  async listActive(): Promise<CategoryView[]> {
    const rows = await this.prisma.reportCategory.findMany({
      where: { isActive: true, OR: [{ parentId: null }, { parent: { isActive: true } }] },
      select: CATEGORY_SELECT,
    });
    return orderTree(rows);
  }

  async listAll(): Promise<CategoryView[]> {
    return orderTree(await this.prisma.reportCategory.findMany({ select: CATEGORY_SELECT }));
  }

  async create(input: CreateCategoryInput, actorId: string, request: Request) {
    if (input.parentId) await this.assertValidParent(input.parentId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.reportCategory.create({ data: input, select: CATEGORY_SELECT });
        await this.audit.record(
          {
            action: 'category.created',
            result: 'SUCCESS',
            actorUserId: actorId,
            targetType: 'category',
            targetId: created.id,
            metadata: { slug: created.slug },
          },
          request,
          tx,
        );
        return created;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException(
          ErrorCode.CONFLICT,
          'A category with this identifier already exists.',
        );
      }
      throw error;
    }
  }

  async update(categoryId: string, input: UpdateCategoryInput, actorId: string, request: Request) {
    const existing = await this.prisma.reportCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, _count: { select: { children: true } } },
    });
    if (!existing) throw new AppException(ErrorCode.NOT_FOUND);
    if (input.parentId) {
      if (input.parentId === categoryId || existing._count.children > 0) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Categories can be at most two levels deep.',
        );
      }
      await this.assertValidParent(input.parentId);
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.reportCategory.update({
        where: { id: categoryId },
        data: input,
        select: CATEGORY_SELECT,
      });
      await this.audit.record(
        {
          action: 'category.updated',
          result: 'SUCCESS',
          actorUserId: actorId,
          targetType: 'category',
          targetId: categoryId,
          metadata: { fields: Object.keys(input) },
        },
        request,
        tx,
      );
      return updated;
    });
  }

  /** Replaces the set of categories an organization handles. Only active categories are allowed. */
  async setOrganizationCategories(
    organizationId: string,
    categoryIds: string[],
    actorId: string,
    request: Request,
  ): Promise<string[]> {
    const unique = [...new Set(categoryIds)];
    const active = await this.prisma.reportCategory.count({
      where: { id: { in: unique }, isActive: true },
    });
    if (active !== unique.length) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, undefined, [
        { field: 'categoryIds', message: 'Every category must exist and be active.' },
      ]);
    }
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.organizationCategory.findMany({
        where: { organizationId },
        select: { categoryId: true },
      });
      await tx.organizationCategory.deleteMany({ where: { organizationId } });
      await tx.organizationCategory.createMany({
        data: unique.map((categoryId) => ({ organizationId, categoryId })),
      });
      const previous = new Set(before.map((row) => row.categoryId));
      await this.audit.record(
        {
          action: 'organization.categories_updated',
          result: 'SUCCESS',
          actorUserId: actorId,
          targetType: 'organization',
          targetId: organizationId,
          metadata: {
            added: unique.filter((id) => !previous.has(id)),
            removed: [...previous].filter((id) => !unique.includes(id)),
          },
        },
        request,
        tx,
      );
    });
    return unique;
  }

  private async assertValidParent(parentId: string): Promise<void> {
    const parent = await this.prisma.reportCategory.findUnique({
      where: { id: parentId },
      select: { parentId: true },
    });
    if (!parent) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, undefined, [
        { field: 'parentId', message: 'The parent category does not exist.' },
      ]);
    }
    if (parent.parentId) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, undefined, [
        { field: 'parentId', message: 'Categories can be at most two levels deep.' },
      ]);
    }
  }
}
