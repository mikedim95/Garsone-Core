#!/usr/bin/env python3
"""Install tested ARM64 GitHub publications from Docker Hub; never build on the Pi."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import sys
import urllib.request

from published_release import resolve_release

HERE = Path(__file__).resolve().parent
REMOTE_DIR = '/opt/garsone/current/Garsone-Core/deploy/pi/full-stack'
IMAGE_KEYS = {'core': 'CORE_IMAGE', 'front': 'FRONT_IMAGE'}


def read_env(path):
    return dict(line.split('=', 1) for line in path.read_text().splitlines()
                if line and not line.startswith('#') and '=' in line)


def atomic_write(path, text):
    temporary = path.with_name(path.name + '.update-tmp')
    with temporary.open('w', encoding='utf-8', newline='\n') as output:
        output.write(text)
        output.flush()
        os.fsync(output.fileno())
    temporary.chmod(0o600)
    os.replace(temporary, path)


def replace_images(original, references):
    remaining = {IMAGE_KEYS[component]: reference for component, reference in references.items()}
    lines = []
    for line in original.splitlines():
        key = line.partition('=')[0]
        if key in remaining:
            line = key + '=' + remaining.pop(key)
        lines.append(line)
    lines.extend(key + '=' + value for key, value in remaining.items())
    return '\n'.join(lines) + '\n'


@contextmanager
def update_lock(directory):
    import fcntl
    with (directory / '.update.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another Pi update is running.') from None
        yield


class Pi:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.env = read_env(self.directory / '.env')
        if self.env.get('IMAGE_MODE', 'published') != 'published':
            raise RuntimeError('This updater requires IMAGE_MODE=published; source/prebuilt installations need an explicit migration.')
        if not (self.directory / 'images.lock.env').is_file():
            raise RuntimeError('Missing images.lock.env; lock the initial installation before updating it.')
        self.command = ['docker', 'compose', '--env-file', '.env', '--env-file', 'images.lock.env', '-f', 'compose.yml']
        if (self.directory / 'compose.site.yml').is_file():
            self.command += ['-f', 'compose.site.yml']
        for key, file in [('BLUETOOTH_ENABLED', 'compose.bluetooth.yml'), ('QR_SYNC_ENABLED', 'compose.qr-sync.yml')]:
            if self.env.get(key) == 'true':
                self.command += ['-f', file]
        # The installed files are authoritative, including the Compose project name.
        self.process_env = {key: value for key, value in os.environ.items()
                            if key not in set(self.env) | {'CORE_IMAGE', 'FRONT_IMAGE', 'POSTGRES_IMAGE', 'COMPOSE_PROFILES', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME'}}

    def run(self, args, **kwargs):
        return subprocess.run(args, cwd=self.directory, env=self.process_env, check=True, **kwargs)

    def compose(self, *args, **kwargs):
        return self.run([*self.command, *args], **kwargs)

    def container(self, service):
        ids = self.compose('ps', '-a', '-q', service, capture_output=True, text=True).stdout.split()
        if len(ids) != 1:
            raise RuntimeError(f'Expected one installed {service} container; found {len(ids)}.')
        return json.loads(self.run(['docker', 'inspect', ids[0]], capture_output=True, text=True).stdout)[0]

    def start(self, *services, recreate=False):
        args = ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '300']
        if recreate:
            args.append('--force-recreate')
        self.compose(*args, *services)

    def healthy(self):
        for service in ('db', 'core', 'front'):
            state = self.container(service)['State']
            if not state.get('Running') or state.get('Health', {}).get('Status') != 'healthy':
                raise RuntimeError(f'{service} is not healthy.')
        port = int(self.env.get('FRONT_PORT', '8080'))
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=15) as response:
            if response.status != 200 or json.load(response).get('status') != 'ok':
                raise RuntimeError('Public API health check failed.')

    def pull(self, release):
        pulled = self.run(['docker', 'pull', '--platform', 'linux/arm64', release['imageTag']], capture_output=True, text=True)
        print(pulled.stdout, end='')
        digests = re.findall(r'^Digest: (sha256:[0-9a-f]{64})\s*$', pulled.stdout, re.M)
        if len(digests) != 1:
            raise RuntimeError('Docker did not return a unique digest for the requested release tag.')
        detail = json.loads(self.run(['docker', 'image', 'inspect', release['imageTag']], capture_output=True, text=True).stdout)[0]
        if detail['Os'] != 'linux' or detail['Architecture'] != 'arm64':
            raise RuntimeError('Published image is not Linux ARM64.')
        repository = 'mikedim95/garsone-' + release['component']
        # A cached image ID can legitimately carry digests for several source commits.
        # Pin the pull receipt for this tag, not an arbitrary inspect-list entry.
        reference = repository + '@' + digests[0]
        if reference not in detail.get('RepoDigests', []):
            raise RuntimeError('Downloaded digest does not match the inspected Docker Hub image.')
        return reference

    def backup_data(self, directory, old_core):
        with (directory / 'database.dump').open('wb') as output:
            self.compose('exec', '-T', 'db', 'sh', '-c', 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc', stdout=output)
        # Validate the dump before touching images. This does not restore or reset data.
        with (directory / 'database.dump').open('rb') as source:
            self.compose('exec', '-T', 'db', 'pg_restore', '--list', stdin=source, stdout=subprocess.DEVNULL)
        for target, name in [('/app/uploads', 'uploads.tar.gz'), ('/app/print-spool', 'print-spool.tar.gz')]:
            mounts = [mount for mount in old_core['Mounts'] if mount['Destination'] == target and mount['Type'] == 'volume']
            if len(mounts) != 1:
                raise RuntimeError(f'Expected a persistent named volume at {target}.')
            with (directory / name).open('wb') as output:
                self.run(['docker', 'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
                          '--mount', f'type=volume,source={mounts[0]["Name"]},target=/backup-source,readonly',
                          '--entrypoint', 'tar', old_core['Image'], '-C', '/backup-source', '-czf', '-', '.'], stdout=output)


def apply(pi, releases):
    lock = pi.directory / 'images.lock.env'
    original = lock.read_text()
    installed = read_env(lock)
    pi.compose('config', '--quiet')
    pi.healthy()
    references = {release['component']: pi.pull(release) for release in releases}
    changed = {component: reference for component, reference in references.items()
               if installed.get(IMAGE_KEYS[component]) != reference or pi.container(component)['Config']['Image'] != reference}
    if not changed:
        print('Already running the selected published images. Nothing restarted.')
        return
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
    backup = pi.directory / 'backups' / ('update-' + stamp)
    backup.mkdir(parents=True, mode=0o700)
    for name in ['.env', 'images.lock.env', 'compose.yml', 'compose.site.yml', 'compose.bluetooth.yml', 'compose.qr-sync.yml', 'printers.json']:
        if (pi.directory / name).is_file():
            shutil.copyfile(pi.directory / name, backup / name)
            (backup / name).chmod(0o600)
    record = {'startedAt': stamp, 'releases': releases, 'changed': changed, 'previousImages': installed,
              'backupDirectory': str(backup), 'databaseRestored': False, 'status': 'preparing'}
    record_file = backup / 'release.json'
    atomic_write(record_file, json.dumps(record, indent=2) + '\n')
    old_core = pi.container('core')
    database_id = pi.container('db')['Id']
    core_update = 'core' in changed
    stopped = False
    pins_changed = False
    try:
        if core_update:
            # Stop customer ingress and Core writers before taking the database snapshot.
            stopped = True
            pi.compose('stop', '--timeout', '30', 'front', 'core')
            pi.backup_data(backup, old_core)
        atomic_write(lock, replace_images(original, changed))
        pins_changed = True
        pi.compose('config', '--quiet')
        if core_update:
            pi.start('core')
            # nginx resolves Core at startup, so refresh it after Core container replacement.
            pi.start('front', recreate=True)
        else:
            pi.start('front')
        pi.healthy()
        for component, reference in changed.items():
            if pi.container(component)['Config']['Image'] != reference:
                raise RuntimeError(f'{component} did not activate the selected image.')
        if pi.container('db')['Id'] != database_id:
            raise RuntimeError('Database container unexpectedly changed.')
        if not core_update and pi.container('core')['Id'] != old_core['Id']:
            raise RuntimeError('Front update unexpectedly changed Core.')
    except BaseException:
        record['status'] = 'failed'
        try:
            if pins_changed:
                atomic_write(lock, original)
            if core_update and stopped:
                # Restore app images only. Never rewind customer data automatically.
                pi.compose('stop', '--timeout', '30', 'front', 'core')
                pi.start('core')
                pi.start('front', recreate=True)
            elif not core_update:
                pi.start('front')
            pi.healthy()
            record['recovery'] = 'Previous app image pins restored; database not restored.'
        except Exception:
            record['recovery'] = 'Automatic app recovery failed; keep ingress closed and inspect the backup before database recovery.'
            try:
                pi.compose('stop', '--timeout', '30', 'front')
            except Exception:
                print('Could not stop customer ingress; inspect Docker immediately.', file=sys.stderr)
        finally:
            try:
                atomic_write(record_file, json.dumps(record, indent=2) + '\n')
            except OSError:
                print(f'Could not save recovery report. Previous configuration is in {backup}.', file=sys.stderr)
        print(f'Update failed. Recovery details: {record_file}', file=sys.stderr)
        raise
    record['status'] = 'healthy'
    atomic_write(record_file, json.dumps(record, indent=2) + '\n')
    atomic_write(pi.directory / '.deployed-release.json', json.dumps(record, indent=2) + '\n')
    print(f'Update healthy. Release record and previous image pins: {backup}')


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'apply'])
    parser.add_argument('--component', choices=['all', 'core', 'front'], default='all')
    parser.add_argument('--channel', choices=['stable', 'stage'], default='stable')
    parser.add_argument('--core-sha')
    parser.add_argument('--front-sha')
    parser.add_argument('--host', help='Run the installed updater through SSH, e.g. piadmin@100.91.30.75')
    parser.add_argument('--remote-dir', default=REMOTE_DIR)
    args = parser.parse_args(argv)
    for component in IMAGE_KEYS:
        sha = getattr(args, component + '_sha')
        if sha and (not re.fullmatch(r'[0-9a-f]{40}', sha) or args.component not in ('all', component)):
            parser.error(f'--{component}-sha requires a full lowercase commit SHA and that component selected.')
    return args


def main(argv=None):
    args = parse_args(argv)
    if args.host:
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@:-]*', args.host):
            raise RuntimeError('Invalid SSH host.')
        remote = ['python3', args.remote_dir.rstrip('/') + '/update.py', args.action, '--component', args.component, '--channel', args.channel]
        for component in IMAGE_KEYS:
            sha = getattr(args, component + '_sha')
            if sha:
                remote += ['--' + component + '-sha', sha]
        return subprocess.run(['ssh', '-o', 'BatchMode=yes', args.host, shlex.join(remote)], check=False).returncode
    if platform.system() != 'Linux' or platform.machine() not in ('aarch64', 'arm64'):
        raise RuntimeError('Run on the ARM64 Pi or use --host piadmin@100.91.30.75 from this computer.')
    os.umask(0o077)
    with update_lock(HERE):
        pi = Pi(HERE)
        token = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN')
        components = list(IMAGE_KEYS) if args.component == 'all' else [args.component]
        releases = [resolve_release(component, args.channel, getattr(args, component + '_sha'), token) for component in components]
        if args.action == 'check':
            print(json.dumps({'installedImages': read_env(HERE / 'images.lock.env'), 'availableReleases': releases,
                              'automaticInstallation': False}, indent=2))
        else:
            apply(pi, releases)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Update error: {error}', file=sys.stderr)
        raise SystemExit(1)
