import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preserveRefreshCredentials } from '../kb/skills/coros-health/scripts/prepare-helper.mjs';
import { officialOauth } from '../kb/skills/coros-health/scripts/coros-wellness.mjs';

const path = new URL('../kb/skills/coros-health/node_modules/coros-mcp/dist/cli.js', import.meta.url);
const original = readFileSync(path, 'utf8');
const patched = preserveRefreshCredentials(original);
const moduleSource = patched.replace('process.exitCode = await main();', 'export { CorosMcpLoginHelper };');
const { CorosMcpLoginHelper } = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'coros-oauth-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const token = join(dir, 'token.json');
  writeFileSync(token, JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
    expires_at_epoch: 1, client_id: 'synthetic-client' }), { mode: 0o600 });
  const helper = new CorosMcpLoginHelper('https://example.invalid', 'https://example.invalid/mcp', token,
    join(dir, 'pending.json'), join(dir, 'catalog.json'), 'synthetic', 'http://localhost/callback');
  return { dir, token, helper };
}

test('patch is idempotent and fails closed on unexpected helper code', () => {
  assert.equal(preserveRefreshCredentials(patched), patched);
  assert.throws(() => preserveRefreshCredentials('unrecognized implementation'), /unsupported/);
});

for (const [status, error] of [[400, 'invalid_grant'], [401, 'invalid_client'], [429, 'rate_limit'], [500, 'server_error'], [503, 'temporarily_unavailable']]) {
  test(`official helper retains byte-identical credentials after refresh ${status}`, async t => {
    const { token, helper } = fixture(t);
    const before = readFileSync(token);
    helper.http = { request: async () => ({ status }), readJson: async () => ({ error }) };
    await assert.rejects(helper.ensureToken(), new RegExp(error));
    assert.deepEqual(readFileSync(token), before);
    assert.equal(statSync(token).mode & 0o777, 0o600);
  });
}

test('network and malformed responses retain credentials; successful refresh replaces them', async t => {
  const { token, helper } = fixture(t);
  const before = readFileSync(token);
  helper.http = { request: async () => { throw new Error('synthetic network failure'); } };
  await assert.rejects(helper.ensureToken(), /network/);
  assert.deepEqual(readFileSync(token), before);
  helper.http = { request: async () => ({ status: 200 }), readJson: async () => ({}) };
  await assert.rejects(helper.ensureToken(), /missing/);
  assert.deepEqual(readFileSync(token), before);
  helper.http.readJson = async () => ({ access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', expires_in: 3600 });
  const result = await helper.ensureToken();
  assert.equal(result.refresh_token, 'synthetic-new-refresh');
  assert.equal(JSON.parse(readFileSync(token)).refresh_token, 'synthetic-new-refresh');
  assert.equal(statSync(token).mode & 0o777, 0o600);
});

test('OAuth status bypasses a cached catalog and distinguishes unknown from rejected', t => {
  const { dir } = fixture(t);
  const fake = join(dir, 'helper.mjs');
  writeFileSync(fake, '#!/usr/bin/env node\nif(process.argv.includes("--refresh")){console.error("invalid_grant");process.exit(1)}console.log("[]");\n');
  chmodSync(fake, 0o700);
  const options = { cacheRoot: dir, helperPath: fake };
  assert.equal(officialOauth('login-status', options).authorized, false);
  writeFileSync(fake, '#!/usr/bin/env node\nconsole.error("synthetic network failure");process.exit(1);\n');
  assert.equal(officialOauth('login-status', options).authorized, null);
});
