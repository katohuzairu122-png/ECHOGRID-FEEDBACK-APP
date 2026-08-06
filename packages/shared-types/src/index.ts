/**
 * Shared types and Zod schemas consumed by both the API (apps/api) and the
 * web app (apps/web). Deliberately does NOT mirror the database schema
 * (apps/api/src/db/schema) -- DB shape is an internal detail of the API
 * service and the two are allowed to diverge. Populated starting with
 * Branch Management's backend (that module's Block 1, 2026-07-08). Earlier
 * request shapes (auth) predate this package being populated and stayed
 * local to apps/api/src/auth/auth.dto.ts -- new features should land their
 * shared request/response contracts here instead.
 */
export * from './common';
export * from './i18n';
export * from './branches';
export * from './businesses';
export * from './qr-codes';
export * from './feedback';
export * from './customer-auth';
export * from './loyalty';
export * from './analytics';
export * from './notifications';
export * from './platform';
export * from './users';
export * from './billing';
export * from './messaging';
