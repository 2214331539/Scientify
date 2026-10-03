"""Native checks run only on disposable GitHub macOS runners."""
import argparse
import hashlib
import json
import os
import pathlib
import plistlib
import shutil
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--native')
parser.add_argument('--bundle')
args = parser.parse_args()
if os.environ.get('GITHUB_ACTIONS') != 'true' or os.uname().machine != 'arm64':
    raise SystemExit('This check requires a disposable GitHub Apple Silicon runner.')
root = pathlib.Path('.test-artifacts/macos').resolve()
root.mkdir(parents=True, exist_ok=True)

def run(*argv, **kwargs):
    return subprocess.run(argv, check=True, text=True, timeout=120, **kwargs)

if args.native:
    report = root / 'native-report.json'
    env = dict(os.environ, SCIENTIFY_NATIVE_SMOKE='1',
               SCIENTIFY_DATA_DIR=str(root / 'native/workspace'),
               SCIENTIFY_NATIVE_REPORT=str(report))
    with (root / 'native.log').open('w') as log:
        subprocess.run([str(pathlib.Path(args.native).resolve())], env=env,
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=180)
    result = json.loads(report.read_text())
    if not result['passed']:
        raise SystemExit(result)
    print(json.dumps(result, ensure_ascii=False))

if args.bundle:
    bundle = pathlib.Path(args.bundle).resolve()
    disks = list((bundle / 'dmg').glob('*.dmg'))
    if len(disks) != 1:
        raise SystemExit('Expected exactly one DMG')
    mount = root / 'mounted'
    mount.mkdir(exist_ok=True)
    installed = root / 'Applications'
    installed.mkdir(exist_ok=True)
    app = installed / 'Scientify.app'
    run('hdiutil', 'verify', str(disks[0]))
    run('hdiutil', 'attach', str(disks[0]), '-nobrowse', '-readonly', '-mountpoint', str(mount))
    try:
        run('ditto', str(mount / 'Scientify.app'), str(app))
    finally:
        run('hdiutil', 'detach', str(mount))
    metadata = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    if metadata['LSMinimumSystemVersion'] != '14.0':
        raise SystemExit('Unexpected minimum macOS version')
    binary = app / 'Contents/MacOS' / metadata['CFBundleExecutable']
    engine = app / 'Contents/MacOS/codex'
    for executable in [binary, engine]:
        arch = run('lipo', '-archs', str(executable), capture_output=True).stdout.strip()
        if arch != 'arm64':
            raise SystemExit(f'Wrong architecture in {executable}: {arch}')
        run('codesign', '--verify', '--strict', '--verbose=2', str(executable))
    run('codesign', '--verify', '--deep', '--strict', '--verbose=2', str(app))
    run(str(engine), '--version')
    if os.environ.get('MACOS_SIGNING') == 'developer-id':
        run('xcrun', 'stapler', 'validate', str(app))
        run('spctl', '--assess', '--type', 'execute', '--verbose=2', str(app))
    # These paths belong to the throwaway runner, never a developer's Mac.
    run(str(binary), '--scientify-migrate-storage')
    data = pathlib.Path.home() / 'Library/Application Support/com.scientify.desktop'
    manifest = json.loads((data / 'scientify-storage.json').read_text())
    container = pathlib.Path(manifest['directory'])
    if not container.is_relative_to(data):
        raise SystemExit('Application data must be outside the signed app')
    sentinel = container / 'release-verification.txt'
    sentinel.write_text('preserve existing research data', encoding='utf8')
    run('ditto', str(bundle / 'macos/Scientify.app'), str(app))
    run(str(binary), '--scientify-migrate-storage')
    if sentinel.read_text() != 'preserve existing research data':
        raise SystemExit('Reinstall changed existing application data')
    # LaunchServices exercises a Finder-style launch with the GUI environment.
    run('open', '-n', str(app))
    time.sleep(8)
    process = run('pgrep', '-f', str(binary), capture_output=True).stdout.strip()
    if not process:
        raise SystemExit('Packaged application did not remain running')
    run('osascript', '-e', 'tell application id "com.scientify.desktop" to quit')
    run('codesign', '--verify', '--deep', '--strict', str(app))
    result = {'passed': True, 'arch': 'arm64', 'minimumSystemVersion': '14.0',
              'signing': os.environ.get('MACOS_SIGNING', 'adhoc'),
              'checks': ['DMG mount', 'app and Agent architecture/signature', 'Agent execution',
                         'external data location', 'reinstall preserves data', 'LaunchServices startup'],
              'dmgSha256': hashlib.sha256(disks[0].read_bytes()).hexdigest()}
    (root / 'package-report.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
