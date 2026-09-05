#!/usr/bin/env python3
"""Code-only component releases. Mutable data never enters a release snapshot."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import subprocess
import tempfile


def atomic(path, content, mode=0o600):
    fd, tmp = tempfile.mkstemp(prefix='.publish-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def inventory(root):
    result = {}
    for path in sorted(root.rglob('*')):
        name = str(path.relative_to(root))
        if name == 'release-manifest.json':
            continue
        if path.is_symlink():
            if not path.resolve().is_relative_to(root.resolve()):
                raise ValueError('external dependency symlink')
            result[name] = {'link': os.readlink(path)}
        elif path.is_file():
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            result[name] = {'sha256': digest.hexdigest(),
                            'mode': path.stat().st_mode & 0o777}
    return result


def verify(release):
    record = json.loads((release / 'release-manifest.json').read_text())
    if record.get('schema') != 1 or record['files'] != inventory(release):
        raise ValueError('release integrity validation failed')


def sync_tree(root):
    for path in root.rglob('*'):
        if path.is_file() and not path.is_symlink():
            with path.open('rb') as stream:
                os.fsync(stream.fileno())
    directories = [p for p in root.rglob('*') if p.is_dir() and not p.is_symlink()]
    for path in sorted(directories, key=lambda p: len(p.parts), reverse=True) + [root]:
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def switch(dest, release):
    pointer = dest / ('.current-' + secrets.token_hex(8))
    try:
        pointer.symlink_to(release.relative_to(dest), target_is_directory=True)
        os.replace(pointer, dest / 'current')
        fd = os.open(dest, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        pointer.unlink(missing_ok=True)


def entrypoints(stage):
    return sorted([p.relative_to(stage) for p in stage.glob('*.sh') if p.name != 'daemon-process.sh'] +
                  [p.relative_to(stage) for p in stage.glob('*.mjs')] +
                  [p.relative_to(stage) for p in stage.glob('dist/*.mjs')])


def wrappers(dest, entries):
    for entry in entries:
        target = dest / entry
        target.parent.mkdir(parents=True, exist_ok=True)
        if entry.suffix == '.sh':
            content = '''#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export KA_COMPONENT_ROOT="$ROOT"
export KA_COMPONENT_CODE_ROOT="$(cd "$ROOT/current" && pwd -P)"
exec bash "$KA_COMPONENT_CODE_ROOT/''' + str(entry) + '''" "$@"
'''
        else:
            # Resolve once, then Node resolves imports/native deps in that release.
            parent = '../' if entry.parent != Path('.') else './'
            content = "import { realpathSync } from 'node:fs';\nimport { fileURLToPath, pathToFileURL } from 'node:url';\n"
            content += f"const root = fileURLToPath(new URL('{parent}', import.meta.url));\n"
            content += "process.env.KA_DAEMON_DATA_DIR ||= root;\n"
            content += f"const entry = realpathSync(root + '/current/{entry}');\n"
            content += "if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.argv[1] = entry;\n"
            content += "await import(pathToFileURL(entry).href);\n"
        atomic(target, content, 0o755 if entry.suffix == '.sh' else 0o644)


def main():
    command, destination, *args = sys.argv[1:]
    dest = Path(destination).resolve()
    if dest == Path('/') or dest == Path.home():
        raise ValueError('unsafe component root')
    releases = dest / '.releases'
    if releases.is_symlink():
        raise ValueError('release store cannot be a symlink')
    if command == 'verify':
        name = args[0]
        if Path(name).name != name or not name.startswith('r-'):
            raise ValueError('invalid release id')
        release = releases / name
        if release.resolve().parent != releases:
            raise ValueError('release escapes component')
        verify(release)
        print(json.dumps({'ok': True, 'release': name}))
        return
    releases.mkdir(parents=True, exist_ok=True)
    if (dest / '.install.lock').is_symlink():
        raise ValueError('install lock cannot be a symlink')
    with open(dest / '.install.lock', 'a+b') as lock:
        os.chmod(dest / '.install.lock', 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        if command == 'begin':
            print(tempfile.mkdtemp(prefix='.stage-', dir=releases))
        elif command == 'publish':
            stage = Path(args[0]).resolve()
            if stage.parent != releases or not stage.name.startswith('.stage-'):
                raise ValueError('stage must be an owned component staging directory')
            entries = entrypoints(stage)
            if not entries:
                raise ValueError('empty component')
            for entry in entries:
                check = ['bash', '-n'] if entry.suffix == '.sh' else ['node', '--check']
                if subprocess.run(check + [str(stage / entry)], capture_output=True).returncode:
                    raise ValueError('component syntax validation failed')
            current = dest / 'current'
            # Legacy layouts require a separate, explicit maintenance decision.
            if not current.is_symlink() and any((dest / e).exists() for e in entries) and '--bootstrap' not in args:
                raise ValueError('legacy layout requires an offline maintenance bootstrap')
            if current.exists() and not current.is_symlink():
                raise ValueError('current must be a release symlink')
            if current.is_symlink():
                old = current.resolve()
                if old.parent != releases:
                    raise ValueError('current points outside component releases')
                verify(old)
                prior = json.loads((old / 'release-manifest.json').read_text())
                if prior['entries'] != [str(e) for e in entries]:
                    raise ValueError('entrypoint changes require a maintenance migration')
            record = {'schema': 1, 'files': inventory(stage), 'entries': [str(e) for e in entries]}
            atomic(stage / 'release-manifest.json', json.dumps(record, sort_keys=True) + '\n')
            verify(stage)
            sync_tree(stage)
            release = releases / ('r-' + secrets.token_hex(12))
            stage.rename(release)
            fd = os.open(releases, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            if not current.is_symlink():
                # Copy only known entrypoints for recovery; never move data/locks.
                backup = dest / ('.legacy-entrypoints-' + secrets.token_hex(6))
                for entry in entries:
                    p = dest / entry
                    if p.is_file():
                        (backup / entry).parent.mkdir(parents=True, exist_ok=True)
                        atomic(backup / entry, p.read_text(), p.stat().st_mode & 0o777)
                wrappers(dest, entries)
            switch(dest, release)
            print(json.dumps({'ok': True, 'release': release.name}))
        elif command in ('rollback', 'verify'):
            name = args[0]
            if Path(name).name != name or not name.startswith('r-'):
                raise ValueError('invalid release id')
            release = releases / name
            if release.resolve().parent != releases:
                raise ValueError('release escapes component')
            verify(release)
            if command == 'rollback':
                current = dest / 'current'
                if not current.is_symlink() or current.resolve().parent != releases:
                    raise ValueError('invalid current release')
                old = json.loads((current.resolve() / 'release-manifest.json').read_text())
                new = json.loads((release / 'release-manifest.json').read_text())
                if old['entries'] != new['entries']:
                    raise ValueError('incompatible rollback entrypoints')
                switch(dest, release)
            print(json.dumps({'ok': True, 'release': name}))
        else:
            raise ValueError('unknown component command')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never dump paths, environment, file contents or credentials.
        print('component release failed: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
