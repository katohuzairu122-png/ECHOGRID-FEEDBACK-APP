import { z } from 'zod';

export const businessCategoryKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]+$/, { error: 'Business category key is invalid.' })
  .min(2)
  .max(80);

export const businessCategorySchema = z.object({
  key: businessCategoryKeySchema,
  name: z.string(),
  groupKey: z.string().nullable(),
  description: z.string().nullable(),
});

export type BusinessCategoryDto = z.infer<typeof businessCategorySchema>;
