import { readFileSync, writeFileSync, renameSync, statSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const marker = '// KA: retain credentials on failed refresh; only explicit logout clears them.';
const original = '            this.tokenStore.clear();\n            throw new AuthFlowError(`token refresh failed: ${sanitizePayload(payload)}`);';

export function assertSafeHelper(file) {
  if (!readFileSync(file, 'utf8').includes(marker)) {
    throw new Error('official helper credential protection missing; run scripts/prepare-helper.mjs');
  }
}

// Narrow, version-checked downstream fix until the official helper preserves
// credentials on errors. Never read OAuth data; patch dependency code only.
export function preserveRefreshCredentials(source) {
  if (source.includes(marker)) return source;
  if (source.split(original).length !== 2) throw new Error('unsupported official helper refresh implementation');
  return source.replace(original, `            ${marker}\n            throw new AuthFlowError(\`token refresh failed: \${sanitizePayload(payload)}\`);`);
}

export function prepareHelper(root = join(dirname(fileURLToPath(import.meta.url)), '..')) {
  const pkg = join(root, 'node_modules', 'coros-mcp');
  if (JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version !== '0.1.1') {
    throw new Error('review credential-preservation patch before upgrading coros-mcp');
  }
  const file = join(pkg, 'dist', 'cli.js');
  const source = readFileSync(file, 'utf8');
  const patched = preserveRefreshCredentials(source);
  if (patched !== source) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, patched, { mode: statSync(file).mode & 0o777 });
    renameSync(tmp, file);
  }
  return { ok: true, helper_version: '0.1.1', credential_preservation: true };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(prepareHelper()));
}
