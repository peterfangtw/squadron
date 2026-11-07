import * as MarkdownIt from 'markdown-it';
import * as assert from 'node:assert/strict';
import { it } from 'node:test';
import { groupView, openThread, stateMessage, threadView } from '../harness';
import * as mentions from '../../webview/mention_text';
import * as refs from '../../core/ticket_ref';
import { ticketPriority, ticketSourceView, ticketState } from '../ticket_fixtures';

const row: TicketView = {
  key: 'issue-a',
  scopeId: 'team-a',
  identifier: 'ENG-42',
  title: 'Check the ticket',
  url: 'https://example.test/issue/ENG-42',
  priority: ticketPriority(),
  state: ticketState('Ready')
};
const reference = '@ticket[ENG-42][https://example.test/issue/ENG-42]';

it('offers only loaded valid ticket references and round-trips their identity through the shared contract', () => {
  const { lines } = mentions.linesFor(
    { tickets: [row, { ...row, url: 'javascript:evil()' }] },
    '',
    []
  );
  assert.equal(lines.length, 1);
  const result = mentions.linesFor({ tickets: [row] }, 'ticket:ENG-42', []).lines;
  const picked = result.find((line): line is mentions.Row => 'act' in line);
  assert.ok(picked && 'mention' in picked.act);
  assert.equal(picked.act.mention.expansion, reference);
  const hit = mentions.mentionOf(picked.act.mention.expansion);
  assert.ok(hit);
  assert.deepEqual(mentions.pillPresentation(hit), {
    label: '@ENG-42',
    className: 'ticket',
    expansion: reference
  });
  assert.equal(
    refs.ticketRef('acme-web#42', 'https://example.test/issues/42?x=[a]'),
    '@ticket[acme-web#42][https://example.test/issues/42?x=%5Ba%5D]'
  );
});

it('renders ticket mentions from either author, keeps code literal and opens details only for the current board', (t) => {
  const thread = threadView({
    exchanges: [
      { role: 'user', text: reference, blocks: [{ prose: reference }] },
      {
        role: 'assistant',
        text: reference,
        blocks: [
          {
            html: `<p>@ticket[ENG-42][<a href="${row.url}">${row.url}</a>]</p><pre><code>${reference}</code></pre>`
          }
        ]
      }
    ]
  });
  const p = openThread(t, thread);
  const doc = p.window.document;
  const pills = doc.querySelectorAll<HTMLElement>('#thread .sref.ticket');
  assert.equal(pills.length, 2);
  assert.equal(pills[0]?.textContent, '@ENG-42');
  assert.equal(doc.querySelector('pre .sref'), null);
  pills[0]?.click();
  assert.deepEqual(p.posted.at(-1), { type: 'openTicketReference', reference });
  p.push(stateMessage([groupView()], { ticketSource: ticketSourceView(), tickets: [row], thread }));
  doc.querySelector<HTMLElement>('#thread .sref.ticket')!.click();
  assert.equal(p.posted.at(-1)?.type, 'readTicket');
  assert.match(doc.querySelector('#ticket-detail')?.textContent ?? '', /ENG-42/);
});

for (const path of ['a%20b', '%E4%B8%AD%E6%96%87', 'a)', '%41', 'a%2Fb']) {
  it(`recovers a ticket reference after real Markdown linkification: ${path}`, (t) => {
    const reference = '@ticket[ENG-42][https://example.test/issue/' + path + ']';
    const html = new MarkdownIt({ linkify: true }).render('Before ' + reference + ' after.');
    const p = openThread(
      t,
      threadView({ exchanges: [{ role: 'assistant', text: reference, blocks: [{ html }] }] })
    );
    const body = p.window.document.querySelector('#thread .body');
    const pill = body?.querySelector<HTMLElement>('.sref.ticket');
    assert.ok(pill);
    assert.equal(body?.textContent?.trim(), 'Before @ENG-42 after.');
    pill.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openTicketReference', reference });
  });
}

it('does not recover a disguised link or a reference inside code', (t) => {
  const html =
    '<p>@ticket[ENG-42][<a href="https://example.test/issue/42">https://different.test/issue/42</a>]</p>' +
    '<code>@ticket[ENG-42][<a href="https://example.test/issue/42">https://example.test/issue/42</a>]</code>';
  const p = openThread(
    t,
    threadView({ exchanges: [{ role: 'assistant', text: html, blocks: [{ html }] }] })
  );
  assert.equal(p.window.document.querySelector('#thread .sref.ticket'), null);
  assert.equal(p.window.document.querySelectorAll('#thread a').length, 2);
});

for (const [name, ticket, ref, expected] of [
  [
    'a mismatched identifier',
    row,
    '@ticket[ENG-1][https://example.test/issue/ENG-42]',
    'openTicketReference'
  ],
  [
    'a normalized URL',
    { ...row, url: 'https://EXAMPLE.test/issue/ENG-42' },
    reference,
    'readTicket'
  ]
] as const) {
  it(`matches the complete ticket identity for ${name}`, (t) => {
    const p = openThread(
      t,
      threadView({ exchanges: [{ role: 'user', text: ref, blocks: [{ prose: ref }] }] }),
      {
        ticketSource: ticketSourceView(),
        tickets: [ticket]
      }
    );
    p.window.document.querySelector<HTMLElement>('#thread .sref.ticket')!.click();
    assert.equal(p.posted.at(-1)?.type, expected);
  });
}
