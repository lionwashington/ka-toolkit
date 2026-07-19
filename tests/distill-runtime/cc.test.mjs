import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const runtimeDir = fileURLToPath(new URL('../../kb/ops/distill-runtimes', import.meta.url))

function runBash(script, env = {}) {
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, KA_DISTILL_RUNTIMES_DIR: runtimeDir, ...env },
  })
}

test('cc distill runtime preserves the existing headless Claude invocation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-distill-runtime-'))
  const bin = join(dir, 'bin')
  const argsFile = join(dir, 'args.txt')
  const outputFile = join(dir, 'output.jsonl')
  const logFile = join(dir, 'worker.log')
  const mkdir = spawnSync('mkdir', ['-p', bin])
  assert.equal(mkdir.status, 0)
  const fakeClaude = join(bin, 'claude')
  writeFileSync(fakeClaude, '#!/bin/bash\nprintf \'%s\\n\' "$@" > "$FAKE_ARGS_FILE"\nprintf \'{"type":"result","result":"ok"}\\n\'\n')
  chmodSync(fakeClaude, 0o755)

  const result = runBash(
    'source "$KA_DISTILL_RUNTIMES_DIR/dispatch.sh"; distill_runtime_load cc; distill_runtime_run "test prompt" "$OUTPUT_FILE" "$LOG_FILE"',
    {
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      FAKE_ARGS_FILE: argsFile,
      OUTPUT_FILE: outputFile,
      LOG_FILE: logFile,
      KA_DISTILL_MODEL: 'test-model',
    },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(argsFile, 'utf8').trim().split('\n'), [
    '-p',
    'test prompt',
    '--model',
    'test-model',
    '--permission-mode',
    'bypassPermissions',
    '--setting-sources',
    'user',
    '--no-session-persistence',
    '--output-format',
    'json',
  ])
  assert.match(readFileSync(outputFile, 'utf8'), /"type":"result"/)
})

test('cc retry classifier accepts only the known thinking-block 400', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-distill-retry-'))
  const output = join(dir, 'output.jsonl')
  const classify = () => runBash(
    'source "$KA_DISTILL_RUNTIMES_DIR/dispatch.sh"; distill_runtime_load cc; distill_runtime_is_retriable "$OUTPUT_FILE"',
    { OUTPUT_FILE: output },
  ).status

  writeFileSync(output, '{"type":"result","is_error":true,"api_error_status":400,"result":"thinking blocks cannot be modified"}\n')
  assert.equal(classify(), 0)
  writeFileSync(output, '{"type":"result","is_error":true,"api_error_status":500,"result":"thinking blocks cannot be modified"}\n')
  assert.notEqual(classify(), 0)
  writeFileSync(output, '{"type":"result","is_error":false,"result":"ok"}\n')
  assert.notEqual(classify(), 0)
})

test('dispatch rejects an unavailable runtime', () => {
  const result = runBash('source "$KA_DISTILL_RUNTIMES_DIR/dispatch.sh"; distill_runtime_load missing')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /unknown runtime 'missing'/)
})

test('codex distill runtime is ephemeral, JSONL, and workspace sandboxed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-distill-codex-'))
  const bin = join(dir, 'bin')
  const argsFile = join(dir, 'args.txt')
  const outputFile = join(dir, 'output.jsonl')
  const logFile = join(dir, 'worker.log')
  assert.equal(spawnSync('mkdir', ['-p', bin]).status, 0)
  const fakeCodex = join(bin, 'codex')
  writeFileSync(fakeCodex, '#!/bin/bash\nprintf \'%s\\n\' "$@" > "$FAKE_ARGS_FILE"\nprintf \'{"type":"turn.completed"}\\n\'\n')
  chmodSync(fakeCodex, 0o755)

  const result = runBash(
    'source "$KA_DISTILL_RUNTIMES_DIR/dispatch.sh"; distill_runtime_load codex; distill_runtime_run "test prompt" "$OUTPUT_FILE" "$LOG_FILE"',
    {
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      FAKE_ARGS_FILE: argsFile,
      OUTPUT_FILE: outputFile,
      LOG_FILE: logFile,
      KA_CODEX_DISTILL_MODEL: 'test-codex-model',
    },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(argsFile, 'utf8').trim().split('\n'), [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '--model',
    'test-codex-model',
    'test prompt',
  ])
})

test('codex retry classifier accepts transient service failures only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-distill-codex-retry-'))
  const output = join(dir, 'output.jsonl')
  const classify = () => runBash(
    'source "$KA_DISTILL_RUNTIMES_DIR/dispatch.sh"; distill_runtime_load codex; distill_runtime_is_retriable "$OUTPUT_FILE"',
    { OUTPUT_FILE: output },
  ).status

  writeFileSync(output, '{"type":"error","message":"Server overloaded; retry later"}\n')
  assert.equal(classify(), 0)
  writeFileSync(output, '{"type":"turn.failed","error":{"message":"sandbox denied write"}}\n')
  assert.notEqual(classify(), 0)
  writeFileSync(output, '{"type":"turn.completed"}\n')
  assert.notEqual(classify(), 0)
})
