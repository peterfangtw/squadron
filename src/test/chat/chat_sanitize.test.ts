import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openThread, threadView } from '../harness';

describe('markup a turn may not carry', () => {
  it('cannot turn malformed Windows links or hostile schemes into file actions', (t) => {
    const hrefs = [
      'C:\\repo\\bad%ZZ.md',
      'C:\\repo\\bad%00.md',
      'C:\\repo\\bad%0a.md',
      'C:\\repo\\file.md:0',
      'C:\\repo\\file.md#L1C0',
      'file://user@server/share/a.md',
      'file://server:80/share/a.md',
      '//server/share/a.md',
      'command:88',
      'java&#x09;script:88',
      'C:relative.md',
      '\\\\?\\C:\\repo\\a.md'
    ];
    const p = openThread(
      t,
      threadView({
        fullCwd: 'C:\\repo',
        exchanges: [
          {
            role: 'assistant',
            text: 'unsafe',
            blocks: [
              {
                html: hrefs.map((href) => `<a href="${href}">file</a>`).join(' ')
              }
            ]
          }
        ]
      })
    );
    const before = p.posted.length;
    const links = p.window.document.querySelectorAll<HTMLElement>('#thread .body a');
    assert.equal(links.length, hrefs.length);
    for (const link of links) {
      link.addEventListener('click', (event) => event.preventDefault());
      link.click();
    }
    assert.deepEqual(p.posted.slice(before), []);
  });
  it('strips scripts, styling and handlers from a turn', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: 'hi',
            blocks: [
              {
                html:
                  '<p onclick="evil()" style="color:red">hi<script>evil()</script></p>' +
                  '<style>body{display:none}</style>'
              }
            ]
          }
        ]
      })
    );
    const bodyEl = p.window.document.querySelector('#thread .body');
    assert.equal(bodyEl?.querySelector('script'), null);
    assert.equal(bodyEl?.querySelector('style'), null);
    const par = bodyEl?.querySelector('p');
    assert.equal(par?.textContent, 'hi');
    assert.equal(par?.attributes.length, 0);
  });

  /** One assistant turn carrying exactly the markup under test. */
  function turnHtml(t: Parameters<typeof openThread>[0], html: string): Element | null {
    const p = openThread(
      t,
      threadView({ exchanges: [{ role: 'assistant', text: 'hi', blocks: [{ html }] }] })
    );
    return p.window.document.querySelector('#thread .body');
  }

  it('drops a form a turn smuggled in, controls and all', (t) => {
    // Parity with the denylist, and the reason the allowlist needs FORBID_TAGS:
    // DOMPurify permits <form> by default, so this would regress silently.
    // The controls are the other half of that parity — removing a tag hoists
    // its children unless the tag also forbids its contents, and `input` and
    // `button` are both in the default allowlist. The denylist took the
    // subtree, so a turn could not draw a control the reader might answer.
    const bodyEl = turnHtml(
      t,
      '<form action="http://evil.example/"><input name="x"><button>go</button></form>'
    );
    assert.equal(bodyEl?.querySelector('form'), null);
    assert.equal(bodyEl?.querySelector('input'), null, 'the form went, its input stayed');
    assert.equal(bodyEl?.querySelector('button'), null, 'the form went, its button stayed');
  });

  it('drops the data attributes a turn would forge an instruction out of', (t) => {
    // DOMPurify allows data-* by default. The board and the tickets list read
    // `data-act` and `data-pid` off whatever a delegated press landed on, and
    // the morph keys by `data-key` — so a turn carrying them is only harmless
    // while no such root contains one. Nothing here spends a data attribute, so
    // this is the cheap half of that: refuse them before the day it matters.
    const bodyEl = turnHtml(t, '<p data-act="close" data-pid="42" data-key="card-42">x</p>');
    const par = bodyEl?.querySelector('p');
    assert.equal(par?.textContent, 'x', 'the element itself survives');
    assert.equal(par?.attributes.length, 0);
  });

  it('drops the title a turn would draw the host tooltip with', (t) => {
    // The other half of H23, and the half no source guard can reach: the panel
    // stopped writing `title=` and draws its own tip, but `[x](url "hover")` is
    // ordinary markdown and DOMPurify allows `title` by default — so a turn
    // could pop the host's slow unthemed tooltip beside ours in the same column.
    const bodyEl = turnHtml(
      t,
      '<a href="https://x" title="native">link</a> <abbr title="also">x</abbr>'
    );
    assert.equal(bodyEl?.querySelector('a')?.getAttribute('title'), null);
    assert.equal(bodyEl?.querySelector('abbr')?.getAttribute('title'), null);
    assert.equal(bodyEl?.querySelector('a')?.getAttribute('href'), 'https://x', 'the link stays');
  });

  it('drops a base a turn would rebase every link with', (t) => {
    const bodyEl = turnHtml(t, '<p>hi</p><base href="http://evil.example/">');
    assert.equal(bodyEl?.querySelector('base'), null);
  });

  it('drops a meta a turn would navigate the panel with', (t) => {
    const bodyEl = turnHtml(
      t,
      '<meta http-equiv="refresh" content="0;url=http://evil.example/"><p>hi</p>'
    );
    assert.equal(bodyEl?.querySelector('meta'), null);
  });

  it('reaches a handler nested inside a template', (t) => {
    // A template's children live in their own fragment, which no walk over the
    // parent's descendants ever reaches — the class of bug an allowlist that
    // recurses into template content closes rather than patches.
    //
    // The leading `<p>` is load-bearing: a template that opens the markup is
    // parsed into the head and dropped whole, which would prove nothing about
    // recursion. Off position 0 the template survives, so the assertions below
    // are about what the sanitizer did *inside* it.
    const bodyEl = turnHtml(t, '<p>hi</p><template><img src="x" onerror="evil()"></template>');
    const held = bodyEl?.querySelector<HTMLTemplateElement>('template')?.content;
    assert.ok(held?.querySelector('img'), 'no content left to have been walked');
    assert.equal(held?.querySelector('[onerror]'), null);
  });
});
