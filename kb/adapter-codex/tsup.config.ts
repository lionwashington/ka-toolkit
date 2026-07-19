import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/hooks/capture-hook.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist/hooks',
  clean: true,
  sourcemap: true,
})
