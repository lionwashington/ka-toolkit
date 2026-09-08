"""Short-lived POSIX lock holder; never a resident service or credential store."""
import fcntl
import os
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True, mode=0o700)
fd = os.open(root / '.kitchen.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
os.fchmod(fd, 0o600)
with os.fdopen(fd, 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    env = dict(os.environ, KITCHEN_LOCK_ROOT=str(root))
    # Child inherits the lock so killing the supervisor cannot unlock its work.
    result = subprocess.run(sys.argv[2:], env=env, pass_fds=(fd,))
    sys.exit(result.returncode)
