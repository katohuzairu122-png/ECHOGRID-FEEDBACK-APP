// Extends Vitest's `expect` with DOM matchers (toBeInTheDocument,
// toHaveValue, toBeRequired, etc.) used across the component tests.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// This config does not set `globals: true`, so React Testing Library's
// automatic afterEach cleanup never registers. Without this, each test's
// rendered output accumulates in the jsdom document and queries like
// getByRole('button', { name: 'Delete' }) fail with "multiple elements".
afterEach(() => {
  cleanup();
});
