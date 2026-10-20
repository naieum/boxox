#!/usr/bin/env python3
"""Fail publication on credentials or personal infrastructure identifiers.

Scans tracked files with --tracked, or the exact generated build directory.
ZIP and TGZ members are read in memory, never extracted by their supplied paths.
Output contains only relative paths, line numbers and rule names, never values.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MAX_MEMBER = 32 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
PRIVATE_PARTS = {'.git', '.loops', '.wrangler', 'snitchfindings', 'node_modules'}
PRIVATE_NAMES = re.compile(r'^(?:\.env(?:\..+)?|\.dev\.vars(?:\..+)?|\.spike-key|.+\.(?:pem|p12|pfx))$')
HOME_PATH = re.compile(r'(?:/Users/|/home/)[\w.-]+|[A-Z]:\\Users\\[\w.-]+')
ACCOUNT = re.compile(r'''(?:/accounts/|\b(?:accountId|account_id|CF_ACCOUNT_ID|ACCOUNT)\b["']?\s*[:=]\s*["'])([a-f0-9]{32})(?![a-f0-9])''', re.I)
WORKER_HOST = re.compile(r'(?<![\w-])(?:[\w-]+\.)*([\w-]+)\.workers\.dev\b', re.I)
ACCESS_HOST = re.compile(r'(?<![\w-])([\w-]+)\.cloudflareaccess\.com\b', re.I)
PERSONAL_EMAIL = re.compile(r'([\w.%+-]+)@(?:gmail|icloud|outlook|hotmail|yahoo)\.com\b', re.I)
PLACEHOLDER_ACCOUNT = re.compile(r'0{31}[12]$')
PLACEHOLDER_HOST = re.compile(r'(?:your-[\w-]+|test-[\w-]+|example|someone|my-mail|boxox-0{12})$', re.I)


def source_path(name):
    """Map archive members back to a stable source path for fixture checks."""
    name = name.split('!')[-1]
    return name.removeprefix('boxox-v2/')


def scan(entries, gitleaks, fixtures):
    findings, mapping = [], {}
    total, count = 0, 0

    def add(rule, name, line=1):
        findings.append({'rule': rule, 'file': name, 'line': line})

    with tempfile.TemporaryDirectory(prefix='boxox-release-privacy-') as temporary:
        work = Path(temporary)
        payloads = work / 'files'
        payloads.mkdir()

        def visit(name, data, depth=0):
            nonlocal total, count
            if len(data) > MAX_MEMBER:
                raise ValueError('Archive/file exceeds scan limit; publication blocked')
            total += len(data)
            if total > MAX_TOTAL:
                raise ValueError('Expanded scan exceeds byte limit; publication blocked')
            count += 1
            parts = Path(name.split('!')[-1]).parts
            basename = parts[-1] if parts else ''
            if any(p in PRIVATE_PARTS for p in parts) or (PRIVATE_NAMES.match(basename) and not basename.endswith('.example')):
                add('private-file', name)
            stream = io.BytesIO(data)
            if name.endswith(('.zip', '.tgz', '.tar.gz')):
                if depth >= 3:
                    raise ValueError('Archive depth exceeds scan limit; publication blocked')
                if name.endswith('.zip'):
                    with zipfile.ZipFile(stream) as archive:
                        for member in archive.infolist():
                            if member.is_dir():
                                continue
                            if member.file_size > MAX_MEMBER:
                                raise ValueError('ZIP member exceeds scan limit; publication blocked')
                            if member.external_attr >> 16 & 0o170000 == 0o120000:
                                raise ValueError('Archive symlink requires review; publication blocked')
                            visit(name + '!' + member.filename, archive.read(member), depth + 1)
                else:
                    with tarfile.open(fileobj=stream, mode='r:gz') as archive:
                        for member in archive:
                            if member.isdir():
                                continue
                            if not member.isfile() or member.size > MAX_MEMBER:
                                raise ValueError('Unsupported/oversized tar member; publication blocked')
                            visit(name + '!' + member.name, archive.extractfile(member).read(), depth + 1)
                return
            texts = [data.decode('utf-8', errors='replace')]
            if b'\0' in data[:1024]:
                texts.extend(data.decode(codec, errors='replace') for codec in ['utf-16-le', 'utf-16-be'])
            for text in texts:
                for pattern, rule, allowed in [
                    (HOME_PATH, 'personal-home-path', lambda m: False),
                    (ACCOUNT, 'non-placeholder-account-id', lambda m: PLACEHOLDER_ACCOUNT.fullmatch(m[1])),
                    (WORKER_HOST, 'non-placeholder-workers-host', lambda m: PLACEHOLDER_HOST.fullmatch(m[1])),
                    (ACCESS_HOST, 'non-placeholder-access-host', lambda m: m[1] in {'your-team', 'you', 't', 'mount-check', 'boxox-test', 'evil'}),
                    (PERSONAL_EMAIL, 'personal-email-address', lambda m: m[1] in {'you', 'me'} or basename == 'THIRD_PARTY_NOTICES'),
                ]:
                    for match in pattern.finditer(text):
                        if not allowed(match):
                            add(rule, name, text.count('\n', 0, match.start()) + 1)
            # Give Gitleaks a separate copy of each leaf. No attacker-supplied
            # member path is used on disk. Preserve the basename for path rules.
            target = payloads / str(len(mapping)) / basename
            target.parent.mkdir()
            target.write_bytes(data)
            mapping[str(target.resolve())] = (name, data)

        for name, data in entries:
            visit(name, data)
        report = work / 'gitleaks.json'
        result = subprocess.run([
            gitleaks, 'dir', str(payloads), '--redact=100', '--no-banner', '--no-color',
            '--ignore-gitleaks-allow', '--max-decode-depth=3', '--report-format=json',
            '--report-path=' + str(report),
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode not in (0, 1) or not report.exists():
            raise ValueError('Credential scanner failed; publication blocked (raw output withheld)')
        candidates = json.loads(report.read_text())
        if result.returncode == 1 and not candidates:
            raise ValueError('Credential scanner returned an inconsistent report; publication blocked')
        for item in candidates:
            key = str(Path(item['File']).resolve())
            if key not in mapping:
                raise ValueError('Unknown scanner file; publication blocked')
            name, data = mapping[key]
            lines = data.decode('utf-8', errors='replace').splitlines()
            excerpt = '\n'.join(lines[item['StartLine'] - 1:item['EndLine']])
            signature = {'rule': item['RuleID'], 'file': source_path(name),
                         'lineSha256': hashlib.sha256(excerpt.encode()).hexdigest()}
            if signature not in fixtures:
                add('credential:' + item['RuleID'], name, item['StartLine'])
    unique = {tuple(sorted(f.items())) for f in findings}
    return [dict(row) for row in sorted(unique)], count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', nargs='?')
    parser.add_argument('--tracked', action='store_true')
    args = parser.parse_args()
    if args.tracked == bool(args.directory):
        parser.error('choose --tracked or a generated directory')
    gitleaks = os.environ.get('GITLEAKS_BIN') or str(ROOT / '.wrangler/tools/gitleaks')
    if not Path(gitleaks).is_file():
        gitleaks = shutil.which('gitleaks')
    if not gitleaks:
        raise ValueError('Run node scripts/install-gitleaks.mjs before the privacy check')
    version = subprocess.check_output([gitleaks, 'version'], text=True).strip()
    if version != '8.30.1':
        raise ValueError('Privacy checks require Gitleaks 8.30.1')
    if args.tracked:
        paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
        selected = [p for p in paths if p and not any(part in PRIVATE_PARTS for part in Path(p).parts)]
        if any((ROOT / p).is_symlink() for p in selected):
            raise ValueError('Tracked symlink requires review; publication blocked')
        entries = [(p, (ROOT / p).read_bytes()) for p in selected]
    else:
        directory = Path(args.directory).resolve()
        inventory = sorted(directory.rglob('*'))
        if any(p.is_symlink() for p in inventory):
            raise ValueError('Build symlink requires review; publication blocked')
        paths = [p for p in inventory if p.is_file()]
        entries = [(p.relative_to(directory).as_posix(), p.read_bytes()) for p in paths]
    fixtures = json.loads((ROOT / 'scripts/release-secret-fixtures.json').read_text())['fixtures']
    findings, count = scan(entries, gitleaks, fixtures)
    if findings:
        for item in findings:
            print(f"{item['file']}:{item['line']} — {item['rule']} (value withheld)", file=sys.stderr)
        print(f'Privacy check failed: {len(findings)} findings', file=sys.stderr)
        return 1
    print(f'Privacy check passed: {count} files/archive members; Gitleaks {version}; no unapproved credential or infrastructure identifier matches')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, zipfile.BadZipFile, tarfile.TarError, subprocess.SubprocessError):
        print('Privacy check could not finish; publication blocked. Check scanner installation, archive formats and size limits. Raw content withheld.', file=sys.stderr)
        sys.exit(2)
