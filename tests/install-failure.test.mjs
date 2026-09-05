import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const source = readFileSync(new URL('../install.sh', import.meta.url), 'utf8').replace(/\nmain\s*$/, '\n')

test('actual KB deployment keeps both legacy entries when native dependency installation fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'ka-native-failure-'))
  try {
    const runtime = join(root, 'runtime')
    const dest = join(runtime, 'kb', 'mcp', 'kb', 'dist')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'index.mjs'), 'old index')
    writeFileSync(join(dest, 'daemon.mjs'), 'old daemon')
    const bin = join(root, 'bin'); mkdirSync(bin)
    writeFileSync(join(bin, 'pnpm'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(bin, 'npm'), '#!/bin/bash\nexit 1\n', { mode: 0o755 })
    const repo = fileURLToPath(new URL('..', import.meta.url))
    const script = join(root, 'install.sh')
    writeFileSync(script, source + '\nREPO_ROOT="$TEST_REPO"\ndeploy_kb_mcp\n[ "$INSTALL_FAILURES" -eq 0 ]\n')
    const result = spawnSync('bash', [script, '--only', 'node-mcp'], { encoding: 'utf8', env: { ...process.env,
      KA_HOME: runtime, TEST_REPO: repo, PATH: bin + ':' + process.env.PATH } })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout, /FAIL npm install natives/)
    assert.equal(readFileSync(join(dest, 'index.mjs'), 'utf8'), 'old index')
    assert.equal(readFileSync(join(dest, 'daemon.mjs'), 'utf8'), 'old daemon')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('reported component failure makes install fail and skips activation', () => {
  const root = mkdtempSync(join(tmpdir(), 'ka-install-failure-'))
  try {
    const steps = ['precheck_deps','deploy_ka','deploy_node_mcp','deploy_kb_mcp','deploy_opennutrition',
      'deploy_python_mcp','deploy_daemon','deploy_lark_daemon','deploy_hooks','deploy_core_cli','deploy_skills',
      'seed_config','persist_targeted_channel_kind','register_mcp','switch_ka_link','switch_cron','switch_hooks',
      'switch_daemon','switch_lark_daemon','switch_skills']
    const script = join(root, 'install.sh')
    writeFileSync(script, source + '\n' + steps.map(name => name + '() { :; }').join('\n') + `
deploy_daemon() { log '  FAIL synthetic build'; return 0; }
switch_daemon() { echo ACTIVATED; }
main
`)
    const result = spawnSync('bash', [script, '--only', 'daemon', '--switch'], { encoding: 'utf8', env: { ...process.env, KA_HOME: join(root, 'runtime') } })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout, /activation skipped/)
    assert.doesNotMatch(result.stdout, /ACTIVATED|all requested deployment steps completed/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a failed or syntactically invalid bundle preserves the installed artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'ka-bundle-failure-'))
  try {
    const compiler = join(root, 'compiler.mjs')
    writeFileSync(compiler, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
const output=process.argv.find(a=>a.startsWith('--outfile=')).slice(10)
writeFileSync(output, process.env.TEST_BUNDLE === 'valid' ? 'export const ok = true' : 'export const broken =')
process.exit(process.env.TEST_BUNDLE === 'failed' ? 1 : 0)
`, { mode: 0o700 })
    const output = join(root, 'deployed.mjs')
    const script = join(root, 'install.sh')
    writeFileSync(script, source + '\nbundle_checked "$TEST_OUTPUT" "$TEST_COMPILER"\n')
    for (const mode of ['failed', 'invalid', 'valid']) {
      writeFileSync(output, 'export const original = true')
      const result = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env,
        KA_HOME: join(root, 'runtime'), TEST_OUTPUT: output, TEST_COMPILER: compiler, TEST_BUNDLE: mode } })
      assert.equal(result.status, mode === 'valid' ? 0 : 1, result.stderr)
      assert.equal(readFileSync(output, 'utf8'), mode === 'valid' ? 'export const ok = true' : 'export const original = true')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('component publication handles absent and enabled bootstrap under system bash nounset', () => {
  const root = mkdtempSync(join(tmpdir(), 'ka-bootstrap-'))
  try {
    const script = join(root, 'install.sh')
    writeFileSync(script, source + '\npython3() { printf "<%s>\\n" "$@"; }\ncomponent_publish /synthetic/dest /synthetic/stage\n')
    for (const enabled of ['0', '1']) {
      const result = spawnSync('/bin/bash', [script], {
        encoding: 'utf8', env: { ...process.env, KA_HOME: join(root, 'runtime'), KA_COMPONENT_BOOTSTRAP: enabled },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /<publish>\n<\/synthetic\/dest>\n<\/synthetic\/stage>/)
      assert.equal(result.stdout.includes('<--bootstrap>'), enabled === '1')
      assert.doesNotMatch(result.stdout, /<>/)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
