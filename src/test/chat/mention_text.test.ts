import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  effortLines,
  findMentions,
  kindOf,
  linesFor,
  PILL_CLASS,
  remember,
  type Line,
  type MentionSources,
  type RecentId,
  type Row
} from '../../webview/mention_text';
import { cardView } from '../harness';

const EFFORTS = ['low', 'medium', 'high'].map((value) => ({ value }));

const opus1m: ModelView = {
  value: 'claude-opus-5-5',
  name: 'Opus 5.5',
  id: 'claude-opus-5-5',
  brand: 'claude',
  brandLabel: 'Claude',
  window: 1_000_000,
  efforts: EFFORTS,
  defaultEffort: 'medium'
};
const opus200k: ModelView = { ...opus1m, window: 200_000 };
const grok: ModelView = {
  value: 'grok-4.7',
  name: 'Grok 4.7',
  id: 'grok-4.7',
  brand: 'grok',
  brandLabel: 'Grok',
  window: 500_000,
  efforts: EFFORTS,
  defaultEffort: 'low'
};
const haiku: ModelView = {
  value: 'claude-haiku-4-5',
  name: 'Haiku 4.5',
  id: 'claude-haiku-4-5',
  brand: 'claude',
  window: 200_000,
  legacy: true
};
/** What `core/codex/models.ts` keeps for a live id the catalog does not know. */
const unknown: ModelView = {
  value: 'gpt-7-nova',
  name: 'GPT-7-Nova',
  id: 'gpt-7-nova',
  brand: 'codex',
  efforts: EFFORTS
};

const MODELS = [opus1m, opus200k, grok, haiku];

const rows = (lines: readonly Line[]): Row[] => lines.filter((l): l is Row => 'act' in l);
const names = (lines: readonly Line[]): string[] =>
  lines.map((l) => ('act' in l ? l.name : `# ${l.head}`));
const mention = (row: Row | undefined) => {
  assert.ok(row && 'mention' in row.act, 'not a mention row');
  return row.act.mention;
};
const find = (lines: readonly Line[], name: string): Row => {
  const row = rows(lines).find((r) => r.name === name);
  assert.ok(row, `no row ${name} in ${names(lines).join(', ')}`);
  return row;
};

const session = (pid: number, name: string, ref?: string): CardView => ({
  ...cardView({ pid, name }),
  ...(ref ? { ref } : {})
});

describe('linesFor', () => {
  it('opens a box offering one kind straight onto its rows, with no heading', () => {
    const { mode, lines } = linesFor({ skills: ['dataviz', 'ponytail'] }, '', []);
    assert.equal(mode, 'search');
    assert.deepEqual(names(lines), ['dataviz', 'ponytail']);
  });

  it('offers the kinds with their counts on a bare @, then Recent', () => {
    const sources: MentionSources = {
      models: MODELS,
      skills: ['ponytail'],
      sessions: [session(7, 'Refine PRDs', '@squadron[7][/t.jsonl]')]
    };
    const { mode, lines } = linesFor(sources, '', [{ kind: 'skill', name: 'ponytail' }]);
    assert.equal(mode, 'kinds');
    assert.deepEqual(names(lines), ['Models', 'Skills', 'Sessions', '# Recent', 'ponytail']);
    // Older models are not counted: the scoped list does not show them.
    assert.deepEqual(
      rows(lines).map((r) => r.meta),
      ['3', '1', '1', undefined]
    );
  });

  it('narrows to a kind on its scope word, and shows older models only once searched', () => {
    const sources = { models: MODELS, skills: ['ponytail'] };
    const scoped = linesFor(sources, 'model:', []);
    assert.equal(scoped.mode, 'model');
    assert.deepEqual(names(scoped.lines), ['# Models', 'Opus 5.5 1M', 'Opus 5.5 200k', 'Grok 4.7']);
    assert.deepEqual(names(linesFor(sources, 'model:hai', []).lines), ['# Models', 'Haiku 4.5']);
  });

  it('reads a scope word for a kind the box does not offer as an ordinary query', () => {
    const sources = { skills: ['model:tune'], sessions: [session(7, 'x', '@squadron[7][/t]')] };
    assert.deepEqual(names(linesFor(sources, 'model:', []).lines), ['# Skills', 'model:tune']);
  });

  it('searches every kind at once, grouped in the sources’ order', () => {
    const sources: MentionSources = {
      models: MODELS,
      skills: ['grok-review'],
      sessions: [session(7, 'grok parity', '@squadron[7][/t]')]
    };
    assert.deepEqual(names(linesFor(sources, 'grok', []).lines), [
      '# Models',
      'Grok 4.7',
      '# Skills',
      'grok-review',
      '# Sessions',
      'grok parity'
    ]);
    // A kind whose name starts with the query is offered first.
    assert.deepEqual(names(linesFor(sources, 'mod', []).lines), ['Models']);
  });

  it('matches a model on the picker’s three fields', () => {
    const sources = { models: MODELS, skills: ['x'] };
    assert.deepEqual(names(linesFor(sources, 'claude-opus', []).lines), [
      '# Models',
      'Opus 5.5 1M',
      'Opus 5.5 200k'
    ]);
    assert.deepEqual(rows(linesFor(sources, 'Claude', []).lines).length, 3);
  });

  it('draws only the rows it was given — no model of its own', () => {
    // The catalog-only rule, where it is enforced: a model the wire did not
    // carry is not findable by any spelling.
    const sources = { models: [grok], skills: ['x'] };
    for (const query of ['opus', 'model:opus', 'claude']) {
      assert.deepEqual(rows(linesFor(sources, query, []).lines), [], query);
    }
  });

  it('leaves out a session with no reference to send, and the gated window stays pickable', () => {
    const sources: MentionSources = {
      models: [{ ...grok, gated: true }],
      sessions: [session(7, 'has ref', '@squadron[7][/t]'), session(8, 'no transcript')]
    };
    assert.deepEqual(names(linesFor(sources, 'session:', []).lines), ['# Sessions', 'has ref']);
    assert.equal(rows(linesFor(sources, 'model:', []).lines)[0]?.gated, true);
  });
});

describe('model mentions', () => {
  it('spells a two-window row with an effort as PRD §5 does', () => {
    const effort = find(effortLines(opus1m, MODELS), 'high');
    assert.deepEqual(mention(effort), {
      kind: 'model',
      label: '@Opus 5.5 1M · high',
      expansion:
        'a peer on Opus 5.5 1M at high effort (squadron-spawn --brand claude --model-id claude-opus-5-5 --context 1000000 --effort high)'
    });
  });

  it('names no window and no effort for a single-window row at its default', () => {
    const row = find(linesFor({ models: MODELS }, 'grok', []).lines, 'Grok 4.7');
    assert.deepEqual(mention(row), {
      kind: 'model',
      label: '@Grok 4.7',
      expansion:
        'a peer on Grok 4.7 (squadron-spawn --brand grok --model-id grok-4.7 --context 500000)'
    });
    assert.equal(row.meta, '500k · Grok');
  });

  it('opens an effort step only for a row with efforts', () => {
    const lines = linesFor({ models: MODELS }, 'model:haiku', []).lines;
    const row = find(lines, 'Haiku 4.5');
    assert.ok('mention' in row.act && row.act.follow === undefined);
    assert.equal(row.more, undefined);
    assert.deepEqual(effortLines(haiku, MODELS), []);
    const opus = find(linesFor({ models: MODELS }, 'model:', []).lines, 'Opus 5.5 1M');
    assert.ok('mention' in opus.act && opus.act.follow === opus1m);
  });

  it('lists a model’s efforts after its default, in the row’s order', () => {
    const lines = effortLines(opus1m, MODELS);
    assert.deepEqual(names(lines), [
      '# Models › Opus 5.5 1M › effort',
      'default',
      'low',
      'medium',
      'high'
    ]);
    assert.equal(find(lines, 'default').meta, 'medium');
    assert.equal(mention(find(lines, 'default')).label, '@Opus 5.5 1M');
  });

  it('filters efforts by value prefix, case-insensitively, including default', () => {
    const model: ModelView = {
      ...opus1m,
      efforts: [
        { value: 'low', description: 'High speed' },
        { value: 'HIGH' },
        { value: 'higher' },
        { value: 'medium' }
      ]
    };
    const queries: [string, string[]][] = [
      ['', ['default', 'low', 'HIGH', 'higher', 'medium']],
      ['h', ['HIGH', 'higher']],
      ['HI', ['HIGH', 'higher']],
      ['higher', ['higher']],
      ['m', ['medium']],
      ['d', ['default']],
      ['DeF', ['default']],
      ['default', ['default']],
      ['ig', []],
      ['speed', []],
      ['defaults', []],
      ['hi ', []]
    ];
    for (const [query, expected] of queries) {
      const lines = effortLines(model, [model], query);
      assert.deepEqual(
        rows(lines).map((row) => row.name),
        expected,
        query
      );
      if (!expected.length) assert.deepEqual(lines, [], query);
    }
    const high = find(effortLines(model, [model], 'hi'), 'HIGH');
    assert.match(mention(high).expansion, /--effort HIGH\)$/);
  });

  it('paints an effort’s value and leaves its catalog sentence off the row', () => {
    const described: ModelView = {
      ...unknown,
      efforts: [
        { value: 'low', description: 'Fast responses with lighter reasoning' },
        { value: 'high', description: 'Greater reasoning depth for complex problems' }
      ],
      defaultEffort: 'high'
    };
    const lines = effortLines(described, [described]);
    assert.equal(find(lines, 'low').meta, undefined);
    assert.equal(find(lines, 'high').meta, undefined);
    assert.equal(find(lines, 'default').meta, 'high');
  });

  it('keeps a windowless row, and sends it without --context', () => {
    const row = find(linesFor({ models: [unknown] }, '', []).lines, 'GPT-7-Nova');
    assert.equal(row.meta, undefined);
    assert.deepEqual(mention(row), {
      kind: 'model',
      label: '@GPT-7-Nova',
      expansion: 'a peer on GPT-7-Nova (squadron-spawn --brand codex --model-id gpt-7-nova)'
    });
    assert.equal(
      mention(find(effortLines(unknown, [unknown]), 'low')).expansion,
      'a peer on GPT-7-Nova at low effort (squadron-spawn --brand codex --model-id gpt-7-nova --effort low)'
    );
  });
});

describe('skill and session mentions', () => {
  it('spells a skill as the measured phrase', () => {
    assert.deepEqual(
      mention(find(linesFor({ skills: ['caveman:caveman'] }, '', []).lines, 'caveman:caveman')),
      {
        kind: 'skill',
        label: '@caveman:caveman',
        expansion: 'the caveman:caveman skill'
      }
    );
  });

  it('spells a session as its card’s name over its reference', () => {
    const ref = '@squadron[7][/t.jsonl]';
    const row = find(
      linesFor({ sessions: [session(7, 'Lane rules', ref)] }, '', []).lines,
      'Lane rules'
    );
    assert.deepEqual(mention(row), { kind: 'session', label: '@Lane rules', expansion: ref });
    assert.equal(row.meta, 'idle · 7');
  });
});

describe('kindOf', () => {
  it('tells every kind this module writes apart, and nothing else', () => {
    assert.equal(kindOf('the ponytail skill'), 'skill');
    assert.equal(kindOf('@squadron[7][/t.jsonl]'), 'session');
    assert.equal(kindOf(mention(find(effortLines(opus1m, MODELS), 'high')).expansion), 'model');
    assert.equal(kindOf('/repo/src/a.ts'), undefined);
  });

  it('calls a model only the shape modelMention writes', () => {
    assert.equal(kindOf('a peer on X (squadron-spawn anything)'), undefined);
  });
});

describe('findMentions reads a model', () => {
  const expansion = (row: Row): string => mention(row).expansion;
  const high = expansion(find(effortLines(opus1m, MODELS), 'high'));
  const plain = expansion(find(linesFor({ models: MODELS }, 'grok', []).lines, 'Grok 4.7'));
  const windowless = expansion(find(linesFor({ models: [unknown] }, '', []).lines, 'GPT-7-Nova'));

  it('reads the stem and effort back out of an expansion with an effort', () => {
    assert.deepEqual(findMentions(high, []), [
      { kind: 'model', at: 0, text: high, stem: 'Opus 5.5 1M', effort: 'high' }
    ]);
  });

  it('reads a pick at its default as a stem with no effort', () => {
    assert.deepEqual(findMentions(plain, []), [
      { kind: 'model', at: 0, text: plain, stem: 'Grok 4.7' }
    ]);
  });

  it('reads a windowless pick, which carries no --context', () => {
    assert.deepEqual(findMentions(windowless, []), [
      { kind: 'model', at: 0, text: windowless, stem: 'GPT-7-Nova' }
    ]);
  });

  it('finds two in one string, left to right, inside prose', () => {
    const text = `Ask ${plain} and ${high}, then compare.`;
    assert.deepEqual(findMentions(text, []), [
      { kind: 'model', at: 4, text: plain, stem: 'Grok 4.7' },
      { kind: 'model', at: 4 + plain.length + 5, text: high, stem: 'Opus 5.5 1M', effort: 'high' }
    ]);
  });

  it('reads a turn written with --model, before the flag was --model-id', () => {
    const old = plain.replace('--model-id', '--model');
    assert.deepEqual(findMentions(old, []), [
      { kind: 'model', at: 0, text: old, stem: 'Grok 4.7' }
    ]);
  });

  it('refuses one broken by a line break', () => {
    assert.deepEqual(findMentions(high.replace(' --model', '\n--model'), []), []);
    assert.deepEqual(findMentions(plain.replace('Grok 4.7', 'Grok\n4.7'), []), []);
  });

  it('leaves prose that only mentions squadron-spawn, and a skill phrase, alone', () => {
    assert.deepEqual(findMentions('a peer on it (squadron-spawn does the rest)', []), []);
    assert.deepEqual(findMentions('run squadron-spawn --brand claude --model-id x', []), []);
    assert.deepEqual(findMentions('the ponytail skill', []), []);
  });
});

describe('findMentions', () => {
  const ref = '@squadron[7][/t.jsonl]';
  const high = mention(find(effortLines(opus1m, MODELS), 'high')).expansion;
  const SKILLS = ['ponytail', 'ponytail-audit'];

  it('reads every kind in one string, left to right, each with its own fields', () => {
    const text = `Ask ${high} to read ${ref} with the ponytail-audit skill.`;
    assert.deepEqual(findMentions(text, SKILLS), [
      { kind: 'model', at: 4, text: high, stem: 'Opus 5.5 1M', effort: 'high' },
      { kind: 'session', at: text.indexOf(ref), text: ref, pid: 7, transcript: '/t.jsonl' },
      {
        kind: 'skill',
        at: text.indexOf('the ponytail-audit'),
        text: 'the ponytail-audit skill',
        name: 'ponytail-audit'
      }
    ]);
  });

  it('drops a hit that starts inside an earlier one', () => {
    const text = `the ${ref} skill`;
    assert.deepEqual(
      findMentions(text, [ref]).map((hit) => [hit.kind, hit.at]),
      [['skill', 0]]
    );
  });

  it('finds no skill when given no names, and the other kinds regardless', () => {
    const text = `the ponytail skill, ${ref}, ${high}`;
    assert.deepEqual(
      findMentions(text, []).map((hit) => hit.kind),
      ['session', 'model']
    );
  });

  it('refuses a skill or model inside a longer word, by one rule', () => {
    for (const glued of ['K', 'é', '_', '-', '7']) {
      assert.deepEqual(findMentions(`${glued}${high}`, []), [], `${glued} before a model`);
      assert.deepEqual(
        findMentions(`${glued}the ponytail skill`, SKILLS),
        [],
        `${glued} before a skill`
      );
    }
    assert.deepEqual(findMentions('the ponytail skills', SKILLS), []);
    assert.deepEqual(
      findMentions(`(${high})`, []).map((hit) => hit.at),
      [1]
    );
  });
});

describe('PILL_CLASS', () => {
  it('names each kind’s pill the way every surface classes it', () => {
    assert.deepEqual(PILL_CLASS, {
      session: 'ref',
      model: 'model',
      skill: 'skill',
      ticket: 'ticket'
    });
  });
});

describe('Recent', () => {
  const opusId: RecentId = {
    kind: 'model',
    brand: 'claude',
    value: 'claude-opus-5-5',
    window: 1_000_000
  };
  const bare = (sources: MentionSources, recent: RecentId[]): Row[] => {
    const lines = linesFor({ skills: ['x'], ...sources }, '', recent).lines;
    const at = lines.findIndex((l) => 'head' in l && l.head === 'Recent');
    return at < 0 ? [] : rows(lines.slice(at));
  };

  it('keeps three picks, newest first, one per identity', () => {
    let recent: RecentId[] = [];
    for (const name of ['a', 'b', 'a', 'c', 'd'])
      recent = remember(recent, { kind: 'skill', name });
    assert.deepEqual(
      recent.map((id) => (id.kind === 'skill' ? id.name : '')),
      ['d', 'c', 'a']
    );
    // The same model at another effort is the same pick.
    recent = remember(remember([], opusId), { ...opusId, effort: 'high' });
    assert.equal(recent.length, 1);
  });

  it('draws a remembered model as the catalog says it is now', () => {
    const renamed = { ...opus1m, name: 'Opus 5.5 (new)', defaultEffort: 'high' };
    const [row] = bare({ models: [renamed, opus200k] }, [opusId]);
    assert.equal(row?.name, 'Opus 5.5 (new) 1M');
    assert.ok(row && 'mention' in row.act && row.act.follow?.defaultEffort === 'high');
  });

  it('keeps a remembered effort while the row lists it, and falls back to the default after', () => {
    const withHigh = bare({ models: MODELS }, [{ ...opusId, effort: 'high' }]);
    assert.equal(mention(withHigh[0]).label, '@Opus 5.5 1M · high');
    const dropped = { ...opus1m, efforts: [{ value: 'low' }] };
    const without = bare({ models: [dropped, opus200k] }, [{ ...opusId, effort: 'high' }]);
    assert.equal(mention(without[0]).label, '@Opus 5.5 1M');
  });

  it('drops a pick whose row is no longer offered', () => {
    // A signed-out brand: its rows leave the wire, so they leave Recent too.
    assert.deepEqual(bare({ models: [grok] }, [opusId]), []);
    assert.deepEqual(bare({}, [{ kind: 'session', pid: 9 }]), []);
  });
});

describe('ticket mention identity', () => {
  it('recognizes a portable reference without any loaded board and rejects unsafe URLs', () => {
    const ref = '@ticket[ENG-42][https://example.test/issue/42]';
    assert.equal(kindOf(ref), 'ticket');
    assert.equal(findMentions('see ' + ref, [])[0]?.text, ref);
    for (const url of [
      'javascript:alert(1)',
      'file:///tmp/a',
      'https://user:pass@example.test/a'
    ]) {
      assert.equal(kindOf('@ticket[ENG-42][' + url + ']'), undefined);
    }
  });
});
