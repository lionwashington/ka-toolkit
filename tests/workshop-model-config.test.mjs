import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('runtime defaults remain isolated and explicit mate arguments win', () => {
  const root = mkdtempSync(join(tmpdir(), 'ka-model-config-'))
  try {
    const config = join(root, 'workshop.yaml')
    writeFileSync(config, `session: test
runtime: codex
models:
  cc: synthetic-claude
  codex: synthetic-codex
mates:
  - name: a
    cwd: /tmp
    args:
      - resume latest
  - name: b
    cwd: /tmp
    runtime: cc
  - name: c
    cwd: /tmp
    model: custom-model
  - name: d
    cwd: /tmp
    model: ignored-model
    args:
      - --model=explicit-model
`)
    const parser = fileURLToPath(new URL('../workshop/ops/yaml-parse.sh', import.meta.url))
    const output = execFileSync('bash', [parser, config], { encoding: 'utf8' })
    assert.match(output, /mate_args\ta\tresume latest\|--model\|synthetic-codex/)
    assert.match(output, /mate_args\tb\t--model\|synthetic-claude/)
    assert.match(output, /mate_args\tc\t--model\|custom-model/)
    assert.match(output, /mate_args\td\t--model=explicit-model/)
    assert.doesNotMatch(output, /ignored-model/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
