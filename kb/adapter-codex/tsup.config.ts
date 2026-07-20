import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/hooks/capture-hook.ts', 'src/rollout-reader-cli.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
})
