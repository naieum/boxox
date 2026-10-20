"""Use the real pinned scanner on synthetic nested artifacts, never real keys."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('release_privacy', ROOT / 'scripts/check-release-privacy.py')
privacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy)
GITLEAKS = os.environ.get('GITLEAKS_BIN', str(ROOT / '.wrangler/tools/gitleaks'))


def archive(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as zipped:
        for name, content in files:
            zipped.writestr(name, content)
    return output.getvalue()


class ReleasePrivacy(unittest.TestCase):
    def test_nested_archive_blocks_identifiers_and_key_without_disclosing_values(self):
        # Construct synthetic data at runtime so the test itself is publishable.
        key = 'ghp_' + hashlib.sha256(b'synthetic-scanner-probe').hexdigest()[:36]
        account = '12345678' * 4
        text = ('token = "' + key + '"\naccount_id: "' + account + '"\n' + '/Users/' + 'private-person/project\n' + 'https://mail.private-person' + '.workers.dev\n' + 'private-person' + '@gmail.com\n')
        outer = archive([('inner.zip', archive([('sample.txt', text)]))])
        findings, count = privacy.scan([('release.zip', outer)], GITLEAKS, [])
        rules = {row['rule'] for row in findings}
        for expected in ['credential:github-pat', 'non-placeholder-account-id', 'personal-home-path', 'non-placeholder-workers-host', 'personal-email-address']:
            self.assertIn(expected, rules)
        self.assertEqual(count, 3)
        self.assertNotIn(key, json.dumps(findings))
        self.assertNotIn(account, json.dumps(findings))

    def test_exact_reviewed_fixture_does_not_hide_a_new_secret_in_the_same_test(self):
        key = 'ghp_' + hashlib.sha256(b'reviewed-scanner-probe').hexdigest()[:36]
        text = 'token = "' + key + '"'
        fixture = {'rule': 'github-pat', 'file': 'test/probe.ts', 'lineSha256': hashlib.sha256(text.encode()).hexdigest()}
        data = archive([('boxox-v2/test/probe.ts', text)])
        self.assertEqual(privacy.scan([('release.zip', data)], GITLEAKS, [fixture])[0], [])
        changed = archive([('boxox-v2/test/probe.ts', text.replace(key, key[:-1] + 'Z'))])
        self.assertTrue(privacy.scan([('release.zip', changed)], GITLEAKS, [fixture])[0])

    def test_private_env_file_fails_even_with_no_secret(self):
        data = archive([('boxox-v2/.env', 'empty=true')])
        findings, _ = privacy.scan([('release.zip', data)], GITLEAKS, [])
        self.assertIn('private-file', {row['rule'] for row in findings})

    def test_placeholder_accounts_hosts_and_required_attribution_are_allowed(self):
        text = 'account_id: "' + '0' * 31 + '1"\nhttps://mail.your-account.workers.dev\nCopyright 2026 Publisher and contributors\n'
        findings, _ = privacy.scan([('example.md', text.encode())], GITLEAKS, [])
        self.assertEqual(findings, [])

    def test_oversized_and_unreadable_archives_block_publication(self):
        with self.assertRaises(zipfile.BadZipFile):
            privacy.scan([('broken.zip', b'not an archive')], GITLEAKS, [])
        old_limit = privacy.MAX_MEMBER
        try:
            privacy.MAX_MEMBER = 4
            with self.assertRaises(ValueError):
                privacy.scan([('too-large.txt', b'12345')], GITLEAKS, [])
        finally:
            privacy.MAX_MEMBER = old_limit


if __name__ == '__main__':
    unittest.main()
