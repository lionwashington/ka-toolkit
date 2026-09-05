import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

// POSIX advisory locks are released by the OS even after SIGKILL. Keep the lock
// inode: unlinking it could let concurrent writers lock different files.
// Python's standard library avoids introducing a native npm dependency.
const CAS = String.raw`
import sys, json, os, hashlib, tempfile, fcntl
p = sys.argv[1]
v = json.load(sys.stdin)
fd = os.open(p + '.lock', os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
with os.fdopen(fd, 'a+b') as lock:
 os.fchmod(lock.fileno(), 0o600)
 fcntl.flock(lock, fcntl.LOCK_EX)
 if os.path.islink(p): sys.exit(4)
 try:
  with open(p, 'rb') as f: old = hashlib.sha256(f.read()).hexdigest()
 except FileNotFoundError: old = None
 if old != v['expected']: sys.exit(3)
 fd, tmp = tempfile.mkstemp(prefix='.raw-write-', dir=os.path.dirname(p))
 try:
  with os.fdopen(fd, 'wb') as f:
   f.write(v['text'].encode('utf8')); f.flush(); os.fsync(f.fileno())
  os.replace(tmp, p)
  d = os.open(os.path.dirname(p), os.O_RDONLY)
  try: os.fsync(d)
  finally: os.close(d)
 finally:
  if os.path.exists(tmp): os.unlink(tmp)
`

export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Transform an exact file revision. Null means no write; conflict is retried. */
export function atomicUpdateText(path: string, transform: (text: string | null) => string | null): boolean {
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null
    const after = transform(before)
    if (after === null || after === before) return false
    const result = spawnSync('python3', ['-c', CAS, path], {
      input: JSON.stringify({ expected: before === null ? null : textHash(before), text: after }),
      encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
    })
    if (result.status === 0) return true
    if (result.status !== 3) throw new Error('atomic raw update failed (writer unavailable, unsafe target or lock timeout)')
  }
  throw new Error('atomic raw update conflicted repeatedly; retry later')
}
