#!/usr/bin/env python3
"""Stop one verified Workshop Codex process group, including detached panes."""
import argparse
import errno
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import time
import urllib.error
import urllib.request


def processes():
    output = subprocess.check_output(
        ['ps', '-axo', 'pid=,pgid=,stat=,command='], text=True)
    result = {}
    for line in output.splitlines():
        fields = line.strip().split(None, 3)
        if len(fields) == 4:
            pid, group, state, command = fields
            result[int(pid)] = (int(group), state, command)
    return result


def stop(home, name, pane_name, port):
    if not name or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789_-' for c in name):
        raise ValueError('invalid channel name')
    lock = home / 'state/codex-app-servers' / (name + '.instance.lock')
    owner = lock / 'pid'
    if lock.is_symlink() or owner.is_symlink():
        raise ValueError('unsafe owner lock')
    pid = int(owner.read_text().strip()) if owner.exists() else None
    table = processes()
    if pid not in table:
        # A vanished wrapper is not proof that its children exited. Do not
        # signal a group without a verified leader, or report false success.
        if pid is not None and any(g == pid and not st.startswith('Z') for g, st, _ in table.values()):
            raise RuntimeError('owner missing but process group remains; manual identity review required')
        entry = str(home / 'workshop/ops/runtimes/codex/bin/start-pane.sh')
        for _, _, command in table.values():
            try:
                args = shlex.split(command)
            except ValueError:
                continue
            if entry in args and args[args.index(entry) + 1:args.index(entry) + 2] == [pane_name]:
                raise RuntimeError('runtime wrapper exists without matching owner; no processes signalled')
    if pid in table:
        group, _, command = table[pid]
        args = shlex.split(command)
        entry = str(home / 'workshop/ops/runtimes/codex/bin/start-pane.sh')
        if entry not in args or args.index(entry) + 1 >= len(args) or args[args.index(entry) + 1] != pane_name:
            raise ValueError('owner PID identity mismatch; no processes signalled')
        if group != pid or group == os.getpgrp():
            raise ValueError('owner has no isolated process group')
        # Snapshot the verified group; TERM reaches TUI, sidecar and registrar
        # together rather than relying on a shell trap blocked in foreground wait.
        try:
            os.killpg(group, signal.SIGTERM)
        except ProcessLookupError:
            pass
        for sig, timeout in [(None, 3), (signal.SIGKILL, 3)]:
            if sig:
                if any(g == group and not st.startswith('Z') for g, st, _ in processes().values()):
                    try:
                        os.killpg(group, sig)
                    except ProcessLookupError:
                        pass
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if not any(g == group and not st.startswith('Z') for g, st, _ in processes().values()):
                    break
                time.sleep(0.05)
        if any(g == group and not st.startswith('Z') for g, st, _ in processes().values()):
            raise RuntimeError('runtime processes still alive')
    # Never unlink a replacement owner's lock.
    if owner.exists():
        if int(owner.read_text().strip()) != pid:
            raise RuntimeError('runtime owner changed during stop')
        owner.unlink()
    if lock.exists():
        lock.rmdir()
    url = f'http://127.0.0.1:{port}'
    try:
        with urllib.request.urlopen(url + '/api/status', timeout=2) as response:
            json.load(response)
    except urllib.error.URLError as error:
        if not isinstance(error.reason, ConnectionRefusedError) and getattr(error.reason, 'errno', None) != errno.ECONNREFUSED:
            raise
        # Offline daemon has no live registration; do not start it.
        return
    request = urllib.request.Request(url + '/api/runtimes/codex/' + name, method='DELETE')
    with urllib.request.urlopen(request, timeout=3) as response:
        response.read()
    with urllib.request.urlopen(url + '/api/status', timeout=3) as response:
        status = json.load(response)
    if any(t['name'] == name for t in status.get('runtime_targets', [])):
        raise RuntimeError('runtime still registered after stop')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('home', type=Path)
    parser.add_argument('channel')
    parser.add_argument('pane')
    parser.add_argument('port', type=int)
    args = parser.parse_args()
    try:
        stop(args.home, args.channel, args.pane, args.port)
        print('Codex runtime stopped and verified')
    except Exception as error:
        print(f'Codex runtime stop failed: {error}', file=__import__('sys').stderr)
        raise SystemExit(1)
