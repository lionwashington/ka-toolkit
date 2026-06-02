import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/hooks/capture-hook.ts', 'src/install.ts', 'src/scheduler.ts'],
  format: ['esm'],
  banner: { js: '#!/usr/bin/env node' },
  dts: true,
  clean: true,
  sourcemap: true,
})
