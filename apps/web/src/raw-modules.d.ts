/**
 * Vite's `?raw` import suffix, typed locally.
 *
 * Vite (and therefore Vitest, which shares its transform pipeline) resolves
 * `import x from './file?raw'` to the file's contents as a string. The
 * ambient declaration for that normally comes from `vite/client`, which this
 * package cannot reference: `vite` arrives only transitively through
 * `vitest`, so under pnpm's isolated node_modules it is not resolvable from
 * apps/web as a direct type reference.
 *
 * Four lines here instead of adding a dependency. This is what lets
 * sw.test.ts read public/sw.js without `@types/node` and `fs.readFileSync`
 * -- which would have meant a new devDependency, a pnpm-lock.yaml change,
 * and a CI `--frozen-lockfile` step to keep in step, all to load one 80-line
 * file that Vite can already hand us as a string.
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
