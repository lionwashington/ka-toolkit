import { defineConfig } from 'tsup'

// Core CLIs are deployed to runtime/core-cli WITHOUT node_modules and invoked by
// bash (cron / doctor) and the distill worker. They must be fully self-contained,
// so bundle ALL third-party deps in (noExternal) + a createRequire shim so any
// CJS dep's bare require() resolves under ESM output. Covers yaml / zod /
// gray-matter — a missing one crashes at runtime with ERR_MODULE_NOT_FOUND.
const cli = {
  format: ['esm'] as const,
  dts: false,
  clean: false,
  sourcemap: true,
  noExternal: [/.*/],
  banner: { js: "#!/usr/bin/env node\nimport{createRequire}from'module';const require=createRequire(import.meta.url);" },
}

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  { entry: { 'jsonl-reader-cli': 'src/capture/jsonl-reader-cli.ts' }, ...cli },
  { entry: { 'daily-log-splitter-cli': 'src/daily-log/splitter-cli.ts' }, ...cli },
  { entry: { 'distill-result-parser-cli': 'src/distill/result-parser-cli.ts' }, ...cli },
  { entry: { 'topics-splitter-cli': 'src/topics/splitter-cli.ts' }, ...cli },
  { entry: { 'config-cli': 'src/config-cli.ts' }, ...cli },
])
