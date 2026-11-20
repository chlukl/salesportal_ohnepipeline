// Production build of the server: bundle src/index.ts + src/worker.ts with esbuild (workspace package
// @sales-portal/shared is inlined, npm dependencies stay external) and copy the SQL migrations.
import { cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist');

rmSync(outdir, { recursive: true, force: true });

/** Keep node_modules imports external, bundle relative imports and the shared workspace package. */
const externalizeDeps = {
  name: 'externalize-deps',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === 'entry-point' || path.isAbsolute(args.path)) return undefined;
      if (args.path.startsWith('@sales-portal/')) return undefined;
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: { index: path.join(root, 'src/index.ts'), worker: path.join(root, 'src/worker.ts') },
  outdir,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  // No code splitting: import.meta.url-relative paths (migrations, web dist) assume files directly in dist/.
  plugins: [externalizeDeps],
  logLevel: 'info',
});

cpSync(path.join(root, 'src/db/migrations'), path.join(outdir, 'migrations'), { recursive: true });
console.log('server build complete →', path.relative(process.cwd(), outdir));
