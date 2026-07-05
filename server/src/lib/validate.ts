import type { ZodSchema } from 'zod';
import { badRequest } from './errors.ts';

/** Boundary validation: parse request body/query with zod, throw 400 on failure. */
export function parse<T>(schema: ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(`${issue.path.join('.') || 'body'}: ${issue.message}`);
  }
  return result.data;
}
