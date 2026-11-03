import * as assert from 'node:assert/strict';
import * as test from 'node:test';
import * as changelog from '../../ui/changelog';

test.it('keeps release notes through the running version, comparing numbers', () => {
  const source =
    '# Changelog\n\n## Unreleased\nFuture\n\n## 0.4.0\n- New\n\n## 0.3.15\n- Current\n  continued\n\n## 0.3.9\n- Old';
  assert.deepEqual(changelog.releases(source, '0.3.15-stg'), [
    { version: '0.3.15', body: '- Current\n  continued' },
    { version: '0.3.9', body: '- Old' }
  ]);
});

test.it('preserves text without interpreting release-note HTML', () => {
  assert.deepEqual(changelog.releases('## 1.0.0\n<script>bad()</script>', '1.0.0'), [
    { version: '1.0.0', body: '<script>bad()</script>' }
  ]);
  assert.deepEqual(changelog.releases('missing', '1.0.0'), []);
});
