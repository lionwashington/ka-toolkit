#!/usr/bin/env node
// Compatibility executable only; no independently discoverable Skill.
export * from '../../kitchen-planner/scripts/nutrition.mjs';
import { runCli } from '../../kitchen-planner/scripts/nutrition.mjs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = error.exitCode || 1;
  });
}
