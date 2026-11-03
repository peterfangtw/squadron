import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as jsdom from 'jsdom';
import { css as baseCss } from '../../ui/css/base';
import { css as boardCss } from '../../ui/css/board';
import { css as chatCss } from '../../ui/css/chat';
import { css as composerCss } from '../../ui/css/composer';
import { css as authCss } from '../../ui/css/auth';
import * as settings from '../../ui/css/settings';
import { css as navCss } from '../../ui/css/nav';
import { css as bottomHubCss } from '../../ui/css/bottom_hub';
import { css as editorCss } from '../../ui/css/editor';
import { css as wfcanvasCss } from '../../ui/css/wfcanvas';
import { css as drawerCss } from '../../ui/css/workflow_overview_drawer';
import { css as bottomDrawerCss } from '../../ui/css/bottom_drawer';
import { css as workflowsModeCss } from '../../ui/css/workflows_mode';
import { css as mascotCss } from '../../ui/css/mascot';
import { css as lightboxCss } from '../../ui/css/lightbox';
import { css as cafeCss } from '../../ui/css/cafe';
import { css as shellCss } from '../../ui/css/shell';
import { css as watermarkCss } from '../../ui/css/watermark';
import { css as proseCss } from '../../ui/css/prose';
import { css as ticketsCss } from '../../ui/css/tickets';
import { panelDocument, panelStylesheet } from '../../ui/document';
import { openPanel, TEST_VERSION } from '../harness';
import { outRoot, repoRoot } from '../helpers';

/**
 * The webview script is inlined into the panel's HTML, which puts three
 * conditions on the compiled file that nothing else would catch — a broken one
 * shows up as a blank panel in the IDE and nowhere else.
 */
describe('the compiled webview script', () => {
  const file = path.join(outRoot(), 'webview', 'main.js');

  it('is built alongside the extension', () => {
    assert.ok(fs.existsSync(file), `${file} is missing — did compile run both projects?`);
  });

  /** The bytes the document serves, proven to be the file's before either
   *  check reads them. */
  const inlined = (): string => {
    const source = fs.readFileSync(file, 'utf8');
    const html = panelDocument(TEST_VERSION);
    const nonce = /'nonce-([^']+)'/.exec(html)?.[1];
    assert.ok(nonce, 'the document names no script nonce');
    assert.ok(
      html.includes(`<script nonce="${nonce}">${source}</script>`),
      'the bundle is not inlined verbatim'
    );
    return source;
  };

  it('is a bare script, with no module system to trip over', () => {
    assert.doesNotMatch(inlined(), /\brequire\(/, 'a require() would throw in the webview');
  });

  // A bundled CommonJS package carries esbuild's own `mod.exports` wrapper,
  // which needs no global, so no textual `exports` ban can tell it from a real
  // reference. Running the script where none of the three exists can.
  it('runs to its handshake with no exports, module or require in scope', (t) => {
    const p = openPanel(t);
    for (const name of ['exports', 'module', 'require']) {
      assert.equal(p.window.eval(`typeof ${name}`), 'undefined', `the document defines ${name}`);
    }
    assert.deepEqual(
      p.onLoad.filter((m) => m.type === 'ready'),
      [{ type: 'ready' }]
    );
  });

  it('cannot close the script tag it is inlined into', () => {
    assert.doesNotMatch(inlined(), /<\/script/i);
  });
});

/**
 * The stylesheet is inlined the same way, and it fails worse: a browser does not
 * report broken CSS, it discards what it cannot parse and carries on. So a stray
 * comment marker takes the rule after it with it, silently, and the only witness
 * is something looking slightly wrong in the IDE.
 *
 * Nothing else here would catch it. `tsc` sees one template literal and is happy
 * with any text inside it, the jsdom harness asserts behaviour rather than paint,
 * and no scenario reads a computed style. This has been written by hand once
 * already: a comment closed twice, and both the compile and 1110 tests passed.
 *
 * These are structural checks only. They say the stylesheet parses as one, not
 * that any rule in it is right — the latter is what `docs/design_tokens/` is for.
 *
 * After the #4 split, they also pin that every surface module still rides the
 * document, in cascade order — a dropped import or a reordered join would paint
 * wrong without failing typecheck.
 */
describe('the inlined stylesheet', () => {
  /** Cascade order — keep lockstep with panelStylesheet() and lift.mjs CSS_PARTS. */
  const SURFACES: readonly { name: string; css: string }[] = [
    { name: 'base', css: baseCss },
    { name: 'shell', css: shellCss },
    { name: 'watermark', css: watermarkCss },
    { name: 'prose', css: proseCss },
    { name: 'board', css: boardCss },
    { name: 'nav', css: navCss },
    { name: 'tickets', css: ticketsCss },
    { name: 'chat', css: chatCss },
    { name: 'composer', css: composerCss },
    { name: 'auth', css: authCss },
    { name: 'settings', css: settings.css },
    { name: 'bottomhub', css: bottomHubCss },
    { name: 'editor', css: editorCss },
    { name: 'wfcanvas', css: wfcanvasCss },
    { name: 'drawer', css: drawerCss },
    { name: 'bottomdrawer', css: bottomDrawerCss },
    { name: 'workflowsmode', css: workflowsModeCss },
    { name: 'mascot', css: mascotCss },
    { name: 'lightbox', css: lightboxCss },
    { name: 'cafe', css: cafeCss }
  ];

  /** Every `<style>` block's contents, joined. */
  const css = (): string =>
    [...panelDocument('1999.1.0').matchAll(/<style>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1] ?? '')
      .join('\n');

  /** The same text with every **well-formed** comment removed. What is left of a
   *  comment marker after this is a marker that was not part of a pair. */
  const uncommented = (): string => css().replace(/\/\*[\s\S]*?\*\//g, '');

  it('has a stylesheet to check', () => {
    assert.ok(css().includes('#bottomhub'), 'no CSS found in the panel document');
  });

  it('closes every comment exactly once', () => {
    // An unclosed `/*` swallows the rules after it; an unpaired `*/` is text
    // where a declaration should be, which is what discards the next rule.
    assert.doesNotMatch(
      uncommented(),
      /\/\*|\*\//,
      'a stray comment marker — one comment is unclosed, or one closes twice'
    );
  });

  it('balances its braces', () => {
    const text = uncommented();
    const opens = (text.match(/{/g) ?? []).length;
    const closes = (text.match(/}/g) ?? []).length;
    assert.equal(opens, closes, `${opens} { against ${closes} }`);
  });

  /**
   * Two rules whose *specificity* is the behaviour. The model bit has to
   * ellipsize or the specs row pushes `.since` off the card's hidden overflow;
   * and the 180px tier hides the model id from a (0,1,0) selector, so anything
   * reaching either class from an ancestor silently outranks the tier — the id
   * comes back at 180px, or the brand mark goes with it. A paint test cannot
   * see that: jsdom computes no cascade for container queries, and the token
   * pages render a card per width rather than a cascade. This can — the shape
   * of the selector is checkable as text.
   */
  it('lets the model ellipsize, without outranking the 180px tier', () => {
    const sheet = panelStylesheet().replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(
      sheet,
      /(^|[\s{}])\.s-model\s*\{[^}]*text-overflow:\s*ellipsis/,
      'no plain `.s-model` ellipsis rule — the specs row drops `.since` instead'
    );
    // The tier takes the id and leaves the mark: `.s-name`, never `.s-model`.
    const tier =
      /@container card \(max-width: 180px\)\s*\{([\s\S]*?)\n {2}\}/.exec(sheet)?.[1] ?? '';
    assert.match(tier, /\.s-name\b/, 'the 180px tier hides no model id');
    assert.doesNotMatch(
      tier,
      /\.s-model\b/,
      'the 180px tier hides .s-model — that takes the brand mark with the id'
    );
    const reaching = [...sheet.matchAll(/[^\s,{}][ >+~]+\.s-(model|name)\b/g)].map((m) =>
      m[0].trim()
    );
    assert.deepEqual(
      reaching,
      [],
      `a rule reaches the model bit from an ancestor: ${reaching.join(', ')}`
    );
  });

  /**
   * jsdom does not evaluate container queries, so the add slot's narrow layout
   * is this text.
   */
  it('restacks the add slot once a half cannot hold its word', () => {
    const sheet = panelStylesheet().replace(/\/\*[\s\S]*?\*\//g, '');
    const tier = (px: number): string =>
      new RegExp(`@container card \\(max-width: ${px}px\\)\\s*\\{([\\s\\S]*?)\\n {2}\\}`).exec(
        sheet
      )?.[1] ?? '';
    const stacked = tier(160);
    assert.match(
      stacked,
      /\.card\.add \.half\s*\{[^}]*flex-direction:\s*column/,
      'the 160px tier does not stack the add slot'
    );
    assert.doesNotMatch(
      stacked,
      /display:\s*none/,
      'the 160px tier drops the Resume / New words while they still fit'
    );
    const icons = tier(130);
    assert.match(
      icons,
      /\.card\.add \.half span\s*\{[^}]*display:\s*none/,
      'the 130px tier still shows a word that no longer fits the half'
    );
  });

  it('each surface contributes CSS declarations', () => {
    const dom = new jsdom.JSDOM('<style></style>');
    const style = dom.window.document.querySelector('style')!;
    const hasDeclarations = (rules: CSSRuleList): boolean =>
      Array.from(rules).some(
        (rule) =>
          ('style' in rule && (rule as CSSStyleRule).style.length > 0) ||
          ('cssRules' in rule && hasDeclarations((rule as CSSGroupingRule).cssRules))
      );
    try {
      for (const { name, css } of SURFACES) {
        style.textContent = css;
        assert.ok(
          style.sheet && hasDeclarations(style.sheet.cssRules),
          `${name} contributes no CSS declarations`
        );
      }
    } finally {
      dom.window.close();
    }
  });

  it('joins every surface module, in cascade order', () => {
    // Exact join is the contract of `panelStylesheet` — drop a part or flip two
    // and this fails before anyone opens the IDE. Whitespace between slices is
    // not byte-identical to the pre-split sheet; paint does not care.
    const sheet = panelStylesheet();
    assert.equal(
      sheet,
      SURFACES.map((s) => s.css).join('\n'),
      'panelStylesheet must join base…cafe in that order only'
    );

    // The document inlines that join (the `<style>` template may pad a newline
    // around the interpolation — trim, then compare, so a second hand-written
    // sheet would still fail).
    const inDocument = panelDocument('1999.1.0').match(/<style>([\s\S]*?)<\/style>/)?.[1];
    assert.equal(
      inDocument?.trim(),
      sheet.trim(),
      'panelDocument must inline panelStylesheet(), not a second sheet'
    );
  });
});

/**
 * H23's own guard, and the only kind that can hold: the panel draws one hover
 * tooltip, and the way it stops drawing two is that a `title=` cannot come back.
 * A scenario proves the sites that exist today say the right words; nothing but
 * this notices the thirtieth one somebody adds next year.
 *
 * Source rather than the bundle, because the bundle is minified and `.title` is
 * a property name the compiler is free to keep for reasons of its own.
 */
describe('the panel writes no native tooltips', () => {
  const dirs = ['webview', 'ui'].map((d) => path.join(repoRoot(), 'src', d));

  /**
   * Three spellings, because the panel writes in three: the property, the
   * setter, and the attribute in `document.ts`'s static markup. A guard against
   * one of them is a guard that reports clean about the other two — and the
   * property one has to tolerate the wrap, since every long assignment in this
   * codebase puts the string on the next line.
   */
  const FORMS = [
    // `node.title = …`, including `node.title =\n  '…'`. The lookahead is what
    // keeps `==` and `===` out; reads of a `.title` *field* on a view model
    // (`call.title`, `t.title`) are untouched by design.
    /\.title\s*=(?!=)/,
    /setAttribute\(\s*['"]title['"]/,
    // Inside a tag, and not after a hyphen: `<button … title="…">` and never a
    // `data-title`. The tag is load-bearing rather than fussy — this file and
    // `document.ts` both *discuss* the title attribute in prose, and a guard on
    // the bare word fires when someone documents why it is gone. A guard that
    // punishes its own explanation is a guard the next person deletes.
    /<[a-z][^>]*(?<![-\w])title=["']/i
  ];

  it('writes no native tooltip, in any of the three spellings', () => {
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.ts')) continue;
        fs.readFileSync(path.join(dir, name), 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (FORMS.some((re) => re.test(line)))
              offenders.push(`${name}:${i + 1} ${line.trim()}`);
          });
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'use `data-tip` (and `aria-label` where the control is a glyph) — see webview/tip.ts'
    );
  });

  /**
   * The guard is only worth what it catches, and the shape it used to miss is
   * the shape this codebase writes: `node.title =` with the string wrapped onto
   * the next line, which four of the sites H23 removed were written as.
   */
  it('catches a title however it is spelled', () => {
    const caught = (line: string): boolean => FORMS.some((re) => re.test(line));
    assert.ok(caught('  node.title = "x";'), 'plain assignment');
    assert.ok(caught('  where.title ='), 'assignment whose string wrapped to the next line');
    assert.ok(caught("  b.setAttribute('title', label);"), 'the setter');
    assert.ok(caught('  <button class="icon" title="Close">'), 'static markup');
    assert.equal(caught('  if (call.title) head.dataset.tip = call.title;'), false, 'a read');
    assert.equal(caught('  if (a.title === b.title) return;'), false, 'a comparison');
  });

  /**
   * And the negatives, which matter more here than usual: this codebase argues
   * in its comments, and the subject it argues about most in these two
   * directories is the attribute being guarded against. A pattern that fires on
   * the prose explaining the rule makes the rule someone else's problem.
   */
  it('does not fire on the prose explaining itself', () => {
    const caught = (line: string): boolean => FORMS.some((re) => re.test(line));
    assert.equal(caught('  // never write title="Close" here — use data-tip'), false, 'a comment');
    assert.equal(caught(' * `title="x"` is the host\'s, not ours'), false, 'a doc comment');
    assert.equal(caught('  node.innerHTML = \'<i data-title="x"></i>\';'), false, 'a data- prefix');
  });
});
