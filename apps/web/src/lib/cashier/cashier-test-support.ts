// Test-only helper: an in-memory stand-in for next/headers cookies().
export function createCookieStore() {
  const jar = new Map<string, { value: string; options?: Record<string, unknown> }>();
  return {
    jar,
    store: {
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
      has: (name: string) => jar.has(name),
      set: (name: string, value: string, options?: Record<string, unknown>) => void jar.set(name, { value, ...(options ? { options } : {}) }),
      delete: (arg: string | { name: string }) => void jar.delete(typeof arg === 'string' ? arg : arg.name),
    },
  };
}
