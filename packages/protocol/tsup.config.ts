import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'], target: 'es2022', outDir: 'dist', clean: true,
  sourcemap: false, dts: true, splitting: false,
  // Browser-pure: zod is bundled so the vendored tgz has no runtime dependency to resolve in MV3.
  noExternal: ['zod'],
});
