import * as assert from 'node:assert/strict';
import { it } from 'node:test';
import * as links from '../../ui/file_link';
import * as fileOpen from '../../ui/file_open';

it('keeps authority HTML in the file service and local HTML in the browser', () => {
  for (const extension of ['.html', '.htm']) {
    assert.equal(fileOpen.writtenFileOpener({ extension, authority: 'Server' }), 'editor');
    assert.equal(fileOpen.writtenFileOpener({ extension, authority: '' }), 'external');
  }
  for (const authority of ['', 'Server']) {
    assert.equal(fileOpen.writtenFileOpener({ extension: '.md', authority }), 'markdown');
    assert.equal(fileOpen.writtenFileOpener({ extension: '.ts', authority }), 'editor');
  }
});

it('preserves literal backslashes under a slash-prefixed UNC cwd', () => {
  assert.deepEqual(links.fileLink('a\\b.md', '//Server/Share/child'), {
    path: '//Server/Share/child/a\\b.md'
  });
  assert.deepEqual(links.fileLink('../a.md', '//Server/Share/name\\literal'), {
    path: '//Server/Share/a.md'
  });
});

it('refuses dot UNC shares and encoded separators in authority file URLs', () => {
  for (const href of [
    '\\\\srv\\.\\x',
    '\\\\srv\\..\\x',
    '%5C%5Csrv%5C%2e%2e%5Cx',
    'file://srv/%2e/x',
    'file://srv/%2e%2e/x',
    'file://srv/share%5C..%5Cother/x',
    'file://srv/share%2fother/x',
    'file://srv/share/child%5cother/x',
    'file://srv/share/child%2Fother/x'
  ])
    assert.equal(links.fileLink(href, '/repo'), undefined, href);
});

it('parses explicit Windows syntax independently of the machine', () => {
  for (const [href, cwd, path] of [
    ['c:\\Repo\\a.md:42:7', '/', 'c:\\Repo\\a.md'],
    ['C:/Repo/a.md:42:7', '/', 'C:/Repo/a.md'],
    ['c:%5CRepo%5Ca.md:42:7', '/', 'c:\\Repo\\a.md'],
    ['%5C%5CServer%5CShare%5Ca.md:42:7', '/', '\\\\Server\\Share\\a.md'],
    ['\\\\server\\share\\a.md:42:7', '/', '\\\\server\\share\\a.md'],
    ['file://Server/Share/a.md#L42C7', '/', '\\\\Server\\Share\\a.md'],
    ['file:///c:/Repo/a.md#L42C7', '/', 'c:/Repo/a.md'],
    ['file://localhost/C:/Repo/a.md#L42C7', '/', 'C:/Repo/a.md'],
    ['../shared/a.md:42:7', 'c:\\Repo\\child', 'c:\\Repo\\shared\\a.md'],
    ['..\\a.md:42:7', '\\\\Server\\Share\\child', '\\\\Server\\Share\\a.md'],
    ['../a.md:42:7', '//Server/Share/child', '//Server/Share/a.md'],
    ['../a.md:42:7', 'C:/Repo/./child/../next', 'C:/Repo/a.md'],
    ['a%5Cb.md:42:7', '/repo', '/repo/a\\b.md']
  ] as const) {
    assert.deepEqual(links.fileLink(href, cwd), { path, line: 42, column: 7 }, href);
  }
});

it('refuses ambiguous Windows roots, schemes, controls and invalid source positions', () => {
  for (const href of [
    '//server/share/a.md',
    'C:relative.md',
    '\\rooted.md',
    '\\\\?\\C:\\a.md',
    '\\\\.\\pipe\\a',
    '\\\\server',
    'file://server/',
    'file://user@server/share/a',
    'file://server:80/share/a',
    'file:///C:relative.md',
    'file:88',
    'command:88',
    'javascript:88',
    'https://example.com:88',
    'unknown:payload',
    'C:\\a%ZZ.md',
    'C:\\a%00.md',
    'C:\\a%0a.md',
    'C:\\a%7f.md',
    'C:\\a\n.md',
    'C:\\a.md:0',
    'C:\\a.md:4:0',
    'C:\\a.md:9007199254740992',
    'C:\\a.md#L0',
    'C:\\a.md#L4C0',
    'C:\\a.md#L-1',
    'C:\\a.md#L4C2x',
    'file:////server/share/a.md',
    '/%2Fserver/share',
    '/%5Cserver/share'
  ])
    assert.equal(links.fileLink(href, 'C:\\Repo'), undefined, href);
});
