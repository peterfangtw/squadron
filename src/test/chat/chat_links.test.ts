import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupView, openThread, stateMessage, threadView } from '../harness';

describe('a link in a turn', () => {
  it('preserves Windows local targets through sanitizing and posts their full positions', (t) => {
    const cases = [
      ['c:\\Repo Mixed\\notes%20draft.md:12:3', 'c:\\Repo Mixed\\notes draft.md'],
      ['D:/Repo/notes.md#L12C3', 'D:/Repo/notes.md'],
      ['/C:/Repo Mixed/notes draft.md:12:3', 'C:/Repo Mixed/notes draft.md'],
      ['/d:/Repo/notes%20draft.md#L12C3', 'd:/Repo/notes draft.md'],
      ['c:%5CRepo%20Mixed%5Cnotes.md:12:3', 'c:\\Repo Mixed\\notes.md'],
      ['\\\\server\\share\\notes.md:12:3', '\\\\server\\share\\notes.md'],
      ['file://server/share/notes%20draft.md#L12C3', '\\\\server\\share\\notes draft.md'],
      ['file:///c:/Repo/notes.md:12:3', 'c:/Repo/notes.md'],
      ['docs\\notes.md:12:3', 'c:\\Repo Mixed\\docs\\notes.md'],
      ['../shared/notes.md#L12C3', 'c:\\shared\\notes.md']
    ];
    const p = openThread(
      t,
      threadView({
        fullCwd: 'c:\\Repo Mixed',
        exchanges: [
          {
            role: 'assistant',
            text: 'files',
            blocks: [
              {
                html: cases.map(([href]) => `<a href="${href}">file</a>`).join(' ')
              }
            ]
          }
        ]
      })
    );
    const links = p.window.document.querySelectorAll<HTMLElement>('#thread .body a');
    for (const [i, [href, path]] of cases.entries()) {
      const link = links[i];
      assert.ok(link);
      assert.equal(link.getAttribute('href'), href);
      link.click();
      assert.deepEqual(p.posted.at(-1), { type: 'openFile', path, line: 12, column: 3 });
    }
  });

  it('asks the host to open an absolute file link in a turn', (t) => {
    const href = '/project/docs/mockups/logo%20preview.html?mode=full#relay';
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: 'Updated the logo preview.',
            blocks: [{ html: `<p>Updated the <a href="${href}">logo preview</a>.</p>` }]
          }
        ]
      })
    );
    const link = p.window.document.querySelector<HTMLElement>('#thread .body a');
    const click = new p.window.MouseEvent('click', { bubbles: true, cancelable: true });
    link?.dispatchEvent(click);
    assert.equal(click.defaultPrevented, true);
    assert.deepEqual(p.posted.at(-1), {
      type: 'openFile',
      path: '/project/docs/mockups/logo preview.html'
    });
  });

  for (const brand of ['claude', 'grok', 'codex'] as const) {
    for (const [suffix, line, column] of [
      [':88', 88, 1],
      [':88:4', 88, 4],
      ['#L88', 88, 1],
      ['#L88C4', 88, 4]
    ] as const) {
      it(`opens a ${brand} turn's ${suffix} link at its file position`, (t) => {
        const p = openThread(
          t,
          threadView({
            brand,
            exchanges: [
              {
                role: 'assistant',
                text: 'glossary',
                blocks: [{ html: `<a href="/project/AGENTS.md${suffix}">glossary</a>` }]
              }
            ]
          })
        );
        const link = p.window.document.querySelector<HTMLElement>('#thread .body a');
        assert.ok(link);
        link.click();
        assert.deepEqual(p.posted.at(-1), {
          type: 'openFile',
          path: '/project/AGENTS.md',
          line,
          column
        });
      });
    }
  }

  for (const brand of ['claude', 'grok', 'codex'] as const) {
    it(`opens relative links in a ${brand} turn from its session directory`, (t) => {
      const cases = [
        ['docs/QA/test-runtime/report.html', '/work/repo #1/docs/QA/test-runtime/report.html'],
        ['./docs/history.md', '/work/repo #1/docs/history.md'],
        ['../shared/notes%20draft.md', '/work/shared/notes draft.md'],
        ['AGENTS.md:88:4', '/work/repo #1/AGENTS.md', 88, 4],
        ['Dockerfile:88', '/work/repo #1/Dockerfile', 88, 1],
        ['README:88:4', '/work/repo #1/README', 88, 4],
        ['makefile:88', '/work/repo #1/makefile', 88, 1],
        ['docs/history.md#L88', '/work/repo #1/docs/history.md', 88, 1],
        ['docs/report.html?mode=full#summary', '/work/repo #1/docs/report.html'],
        ['notes%3A88.md', '/work/repo #1/notes:88.md'],
        ['file:///work/notes%20draft.md:88:4', '/work/notes draft.md', 88, 4]
      ] as const;
      const p = openThread(
        t,
        threadView({
          brand,
          fullCwd: '/other/origin',
          liveCwd: '/work/repo #1',
          exchanges: [
            {
              role: 'assistant',
              text: 'files',
              blocks: [
                {
                  html: cases.map(([href]) => `<a href="${href}">file</a>`).join(' ')
                }
              ]
            }
          ]
        })
      );
      const links = p.window.document.querySelectorAll<HTMLElement>('#thread .body a');
      for (const [i, [, path, line, column]] of cases.entries()) {
        const link = links[i];
        assert.ok(link);
        const click = new p.window.MouseEvent('click', { bubbles: true, cancelable: true });
        link.dispatchEvent(click);
        assert.equal(click.defaultPrevented, true);
        assert.deepEqual(p.posted.at(-1), {
          type: 'openFile',
          path,
          ...(line === undefined ? {} : { line, column })
        });
      }
    });
  }

  it('updates relative links when the session directory changes', (t) => {
    const view = threadView({
      fullCwd: '/work/origin',
      exchanges: [
        {
          role: 'assistant',
          text: 'history',
          blocks: [
            {
              html: '<a href="docs/history.md">history</a>'
            }
          ]
        }
      ]
    });
    const p = openThread(t, view);
    p.window.document.querySelector<HTMLElement>('#thread .body a')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openFile', path: '/work/origin/docs/history.md' });
    p.push(stateMessage([groupView()], { thread: { ...view, liveCwd: '/work/moved' } }));
    p.window.document.querySelector<HTMLElement>('#thread .body a')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openFile', path: '/work/moved/docs/history.md' });
  });

  it('keeps an encoded colon and digits as part of the filename', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: 'file',
            blocks: [{ html: '<a href="/project/notes%20draft.md%3A88">file</a>' }]
          }
        ]
      })
    );
    const link = p.window.document.querySelector<HTMLElement>('#thread .body a');
    assert.ok(link);
    link.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'openFile',
      path: '/project/notes draft.md:88'
    });
  });

  it('refuses zero and unsafe file positions', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: 'invalid positions',
            blocks: [
              {
                html: [':0', ':88:0', ':9007199254740992', '#L0', '#L88C9007199254740992']
                  .map((suffix) => `<a href="/project/AGENTS.md${suffix}">file</a>`)
                  .join(' ')
              }
            ]
          }
        ]
      })
    );
    const before = p.posted.length;
    for (const link of p.window.document.querySelectorAll<HTMLElement>('#thread .body a')) {
      link.addEventListener('click', (event) => event.preventDefault(), { once: true });
      link.click();
    }
    assert.equal(
      p.posted.slice(before).some((message) => message.type === 'openFile'),
      false
    );
  });

  it('leaves non-local links to native navigation', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: 'Links.',
            blocks: [
              {
                html:
                  '<p><a href="https://example.com">web</a>' +
                  '<a href="//example.com/share">network</a>' +
                  '<a href="/%2Fhost/share">encoded network</a>' +
                  '<a href="/%5Chost/share">encoded windows network</a>' +
                  '<a href="#section">anchor</a>' +
                  '<a href="?mode=full">query</a>' +
                  '<a href="mailto:hello@example.com">email</a>' +
                  '<a href="sms:88">sms</a>' +
                  '<a href="callto:88">call</a>' +
                  '<a href="ftps:88">secure ftp</a>' +
                  '<a href="https://example.com:88">web position</a>' +
                  '<a href="docs/bad%ZZ.md">bad encoding</a>' +
                  '<a href="docs/null%00.md">null</a>' +
                  '<a href="file://server/">incomplete share</a>' +
                  '<a href="file:88">relative file URI</a>' +
                  '<a href="file:88:4">positioned relative file URI</a>' +
                  '<a href="javascript:88">script</a>' +
                  '<a href="JaVaScRiPt:88">mixed script</a>' +
                  '<a href="java&#x73;cript:88">entity script</a>' +
                  '<a href="java&#x09;script:88">tab script</a>' +
                  '<a href="command:88">command</a>' +
                  '<a href="vscode:88">IDE</a></p>'
              }
            ]
          }
        ]
      })
    );
    const links = [...p.window.document.querySelectorAll<HTMLElement>('#thread .body a')];
    for (const label of [
      'script',
      'mixed script',
      'entity script',
      'tab script',
      'command',
      'IDE',
      'relative file URI',
      'positioned relative file URI'
    ]) {
      const link = links.find((candidate) => candidate.textContent === label);
      assert.ok(link);
      assert.equal(link.getAttribute('href'), null, label);
    }
    for (const [label, href] of [
      ['web', 'https://example.com'],
      ['email', 'mailto:hello@example.com'],
      ['web position', 'https://example.com:88'],
      ['sms', 'sms:88'],
      ['call', 'callto:88'],
      ['secure ftp', 'ftps:88']
    ]) {
      assert.equal(
        links.find((candidate) => candidate.textContent === label)?.getAttribute('href'),
        href
      );
    }
    const before = p.posted.length;
    for (const link of p.window.document.querySelectorAll<HTMLElement>('#thread .body a')) {
      // jsdom schedules an unimplemented navigation after an uncancelled click.
      link.addEventListener('click', (event) => event.preventDefault(), { once: true });
      link.click();
    }
    assert.equal(
      p.posted.slice(before).some((message) => message.type === 'openFile'),
      false
    );
  });
});
