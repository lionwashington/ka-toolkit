import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'


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
