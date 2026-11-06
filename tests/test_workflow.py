"""Deployment wiring checks; no network or production mutation."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]

class WorkflowTests(unittest.TestCase):
    def test_pages_publishes_only_after_tests_and_verified_restore(self):
        path = ROOT/'.github/workflows/pages.yml'
        self.assertTrue(path.is_file(), 'Verified Pages deployment workflow is missing')
        text = path.read_text()
        uses = re.findall(r'uses: ([^\s]+)', text)
        self.assertEqual(len(uses), 6)
        self.assertTrue(all(re.fullmatch(r'actions/[a-z-]+@[0-9a-f]{40}', value) for value in uses))
        self.assertIn('branches: [main]', text)
        self.assertIn('contents: read', text)
        self.assertIn('pages: write', text)
        self.assertIn('id-token: write', text)
        self.assertIn('environment:', text)
        self.assertIn('github-pages', text)
        self.assertIn('tests/diagnostics.test.js', text)
        self.assertIn('python -m pytest', text)
        self.assertIn('release_bundle.py restore', text)
        self.assertIn('--manifest release-data.json', text)
        self.assertLess(text.index('release_bundle.py restore'), text.index('actions/upload-pages-artifact@'))
        self.assertIn('path: _site', text)
        self.assertNotIn('pull_request_target', text)
        self.assertNotIn('contents: write', text)

if __name__ == '__main__':
    unittest.main()
