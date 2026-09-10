import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const helper = fileURLToPath(new URL('../workshop/ops/runtimes/codex/detached-process.mjs', import.meta.url))

test('registrar Node exit cannot restore stale stderr termios over the TUI', { skip: process.platform === 'win32' }, () => {
  const source = readFileSync(new URL('../workshop/ops/runtimes/codex/bin/start-pane.sh', import.meta.url), 'utf8')
  const launches = source.split('\n').filter(line => /^\s*(register_loop |discover_and_register_fresh_thread ).*&$/.test(line))
  assert.equal(launches.length, 2)
  assert.doesNotMatch(source, /stty -icanon/, 'no periodic or startup mode repair')
  for (const launch of launches) assert.match(launch, /<\/dev\/null >>"\$SERVER_LOG" 2>&1 &$/)
  const python = String.raw`import os,pty,subprocess,sys,select,termios,tty,tempfile,time,json
pid,fd=pty.fork()
if pid==0:
 try:
  # Ordinary Node (not a simulated tcsetattr attacker) snapshots stdio and
  # restores it at exit. Handshakes force the previously timing-dependent race.
  with tempfile.TemporaryDirectory(prefix='ka-registrar-pty-') as root:
   for index,line in enumerate(['register_loop &']+json.loads(sys.argv[1])):
    tty.tcsetattr(0,termios.TCSANOW,original) if index else None
    original=termios.tcgetattr(0)
    ready=root+'/ready'+str(index);release=root+'/release'+str(index)
    js='const fs=require("fs");fs.writeFileSync(process.env.READY,"1");const t=setInterval(()=>{if(fs.existsSync(process.env.RELEASE)){clearInterval(t)}},5)'
    shell='register_loop() { node -e '+"'"+js+"'"+'; }; discover_and_register_fresh_thread() { register_loop; }; '+line+'\nwait $!'
    env={**os.environ,'READY':ready,'RELEASE':release,'SERVER_LOG':root+'/server.log','CANONICAL_THREAD_ID':'fixture','CANONICAL_THREAD_PATH':'fixture'}
    p=subprocess.Popen(['bash','-c',shell],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL)
    deadline=time.monotonic()+5
    while not os.path.exists(ready):
     assert time.monotonic()<deadline,'Node readiness timeout'
     time.sleep(.01)
    tty.setraw(0)
    open(release,'w').close();p.wait(timeout=5)
    a=termios.tcgetattr(0)
    raw=not a[3]&(termios.ICANON|termios.ECHO) and not a[0]&termios.ICRNL
    assert raw==(index!=0),(index,a)
   os.write(1,b'PASS\n')
  os._exit(0)
 except BaseException as error:
  os.write(2,('FAIL '+str(error)+'\n').encode());os._exit(1)
data=b''
while True:
 if not select.select([fd],[],[],5)[0]: raise Exception('PTY timeout')
 try: chunk=os.read(fd,4096)
 except OSError: break
 if not chunk: break
 data+=chunk
_,status=os.waitpid(pid,0)
assert os.waitstatus_to_exitcode(status)==0,data
assert b'PASS' in data,data
`
  const result = spawnSync('python3', ['-c', python, JSON.stringify(launches)], { encoding: 'utf8', timeout: 20000 })
  assert.equal(result.status, 0, result.stderr)
})

test('sidecar cannot open the pane controlling tty; raw keyboard input remains intact', { skip: process.platform === 'win32' }, () => {
  const script = String.raw`
import os, pty, termios, tty, subprocess, json, select, sys
pid, master = pty.fork()
if pid == 0:
    try:
        tty.setraw(0)
        # Model a sidecar which tries /dev/tty even though stdio is redirected.
        attack = '''import os,json,termios
try:
 fd=os.open('/dev/tty',os.O_RDWR)
 a=termios.tcgetattr(fd);a[3]|=termios.ICANON|termios.ECHO;a[0]|=termios.ICRNL
 termios.tcsetattr(fd,termios.TCSANOW,a)
 print(json.dumps({'controlling_tty':True}))
except OSError:
 print(json.dumps({'controlling_tty':False}))
'''
        baseline = subprocess.run([sys.executable, '-c', attack], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        assert baseline.returncode == 0, baseline.stderr
        assert json.loads(baseline.stdout)['controlling_tty'] is True
        assert termios.tcgetattr(0)[3] & termios.ICANON
        tty.setraw(0)
        child = subprocess.run([sys.argv[1], sys.argv[2], sys.executable, '-c', attack], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        assert child.returncode == 0, child.stderr
        assert json.loads(child.stdout)['controlling_tty'] is False
        attrs = termios.tcgetattr(0)
        assert not attrs[3] & (termios.ICANON | termios.ECHO)
        assert not attrs[0] & termios.ICRNL
        os.write(1,b'READY\n')
        keys=b''
        while len(keys)<4:
            assert select.select([0],[],[],3)[0], 'keyboard input timed out'
            keys += os.read(0,4-len(keys))
        assert keys == b'\x1b[B\r', repr(keys)
        os.write(1,b'PASS\n')
        os._exit(0)
    except BaseException as error:
        os.write(2,('FAIL '+str(error)+'\n').encode())
        os._exit(1)
data=b''
try:
    while b'READY\n' not in data:
        assert select.select([master],[],[],12)[0], 'sidecar readiness timed out'
        data+=os.read(master,4096)
    os.write(master,b'\x1b[B\r')
    while b'PASS\n' not in data:
        assert select.select([master],[],[],5)[0], 'keyboard verification timed out'
        data+=os.read(master,4096)
    assert b'^[[B' not in data, 'arrow key was echoed'
    _,status=os.waitpid(pid,0)
    assert os.waitstatus_to_exitcode(status)==0, data
finally:
    os.close(master)
print('isolated PTY: no sidecar controlling TTY; raw arrow/Enter received')
`
  const result = spawnSync('python3', ['-c', script, process.execPath, helper], { encoding: 'utf8', timeout: 20000 })
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error))
})

test('detached supervisor preserves exit status and reports missing executable without argv', () => {
  const result = spawnSync(process.execPath, [helper, process.execPath, '-e', 'process.exit(23)'], { encoding: 'utf8' })
  assert.equal(result.status, 23)
  const missing = spawnSync(process.execPath, [helper, '/no-such-ka-test-executable', 'private-test-argument'], { encoding: 'utf8' })
  assert.equal(missing.status, 127)
  assert.match(missing.stderr, /ENOENT/)
  assert.doesNotMatch(missing.stderr, /private-test-argument/)
})

test('detached supervisor forwards shutdown and bounds an unresponsive child', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [helper, process.execPath, '-e', 'process.on("SIGTERM",()=>{});console.log("READY");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await once(child.stdout, 'data')
    const exited = once(child, 'exit')
    const started = Date.now()
    child.kill('SIGTERM')
    const [code, signal] = await exited
    assert.equal(signal, null)
    assert.equal(code, 137)
    assert.ok(Date.now() - started < 8000, 'shutdown must not wait indefinitely')
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
})
