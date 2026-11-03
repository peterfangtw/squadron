import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AwakeReason } from '../../core/awake';
import type { MessengerSetup, SetupCheck } from '../../core/bridge/port';
import * as port from '../../core/bridge/port';
import * as link from '../../core/remote/link';
import * as remoteView from '../../ui/remote_view';

const MANIFEST = 'display_information: MANIFEST-BLOB-7731';
const CREATE_URL = 'https://create.example.test/new-app';

const setup: MessengerSetup = {
  fields: [
    { key: 'bot', label: 'Bot token' },
    { key: 'app', label: 'App token' }
  ],
  sender: { help: 'Your member id, from your profile.', placeholder: 'T…:U…' },
  create: {
    steps: [
      { title: 'Open it', text: 'Open the create page.' },
      { title: 'Paste it', text: 'Paste the manifest.' }
    ],
    copy: { label: 'Copy manifest', text: MANIFEST },
    link: CREATE_URL
  }
};

function view(
  state: link.RemoteLink,
  extra: {
    refused?: link.Refused;
    awake?: AwakeReason;
    awakeRemote?: false;
    allowlist?: string[];
    unset?: string;
  } = {}
): link.RemoteView {
  return {
    state,
    setup: {
      messenger: { id: 'chat', label: 'Chat' },
      fields: setup.fields.map(({ key, label }) => ({ key, label, set: key !== extra.unset })),
      allowlist: extra.allowlist ?? ['T1:U1']
    },
    ...(extra.refused ? { refused: extra.refused } : {}),
    ...(extra.awake ? { awake: extra.awake } : {}),
    ...(extra.awakeRemote === false ? { awakeRemote: false as const } : {})
  };
}

const ON_STATES: link.RemoteLink[] = [
  { kind: 'connecting' },
  { kind: 'connected', since: 1 },
  { kind: 'reconnecting', reason: 'The network went away.' },
  { kind: 'failed', reason: 'The bot token was refused.', retry: false }
];

describe('remoteStateView: each state', () => {
  it('draws off as a switch off, with no tone', () => {
    const out = remoteView.remoteStateView(view({ kind: 'off' }), setup);
    assert.equal(out.on, false);
    assert.equal(out.tone, 'off');
    assert.equal(out.status, 'Off');
    assert.equal(out.reason, undefined);
  });

  it('carries the reason Remote went off by itself', () => {
    const out = remoteView.remoteStateView(
      view({ kind: 'off', reason: 'Remote went off here: Work holds it now.' }),
      setup
    );
    assert.equal(out.on, false);
    assert.equal(out.reason, 'Remote went off here: Work holds it now.');
  });

  it('draws connecting as on and pending', () => {
    const out = remoteView.remoteStateView(view({ kind: 'connecting' }), setup);
    assert.deepEqual([out.on, out.tone, out.status], [true, 'pending', 'Connecting…']);
  });

  it('draws connected as on and live, with the lid hint', () => {
    const out = remoteView.remoteStateView(view({ kind: 'connected', since: 1 }), setup);
    assert.deepEqual([out.on, out.tone, out.status], [true, 'live', 'Connected']);
    assert.equal(out.hint, 'Keep the lid open: a closed lid sleeps regardless.');
    assert.deepEqual(out.warnings, []);
  });

  it("lists a connected link's warning, with no fix", () => {
    const out = remoteView.remoteStateView(
      view({ kind: 'connected', since: 1, warning: 'These tokens are connected elsewhere too.' }),
      setup
    );
    assert.deepEqual(out.warnings, [{ text: 'These tokens are connected elsewhere too.' }]);
  });

  it('draws reconnecting as on and pending, with its reason', () => {
    const out = remoteView.remoteStateView(
      view({ kind: 'reconnecting', reason: 'The network went away.' }),
      setup
    );
    assert.deepEqual([out.on, out.tone, out.status], [true, 'pending', 'Reconnecting']);
    assert.equal(out.reason, 'The network went away.');
  });

  it('draws failed as on and at fault, with its reason', () => {
    const out = remoteView.remoteStateView(
      view({ kind: 'failed', reason: 'The bot token was refused.', retry: false }),
      setup
    );
    assert.deepEqual([out.on, out.tone, out.status], [true, 'fault', 'Not connected']);
    assert.equal(out.reason, 'The bot token was refused.');
  });

  it('names the window that holds Remote elsewhere, with its folder for the tip', () => {
    const out = remoteView.remoteStateView(
      view({ kind: 'elsewhere', holder: { label: 'api', folder: '/work/api' } }),
      setup
    );
    assert.deepEqual([out.on, out.tone], [false, 'elsewhere']);
    assert.equal(out.status, 'On in another window: api');
    assert.equal(out.holderPath, '/work/api');
  });

  it('draws no hint while not connected', () => {
    for (const state of [
      { kind: 'off' } as const,
      ...ON_STATES.filter((s) => s.kind !== 'connected')
    ]) {
      assert.equal(remoteView.remoteStateView(view(state), setup).hint, undefined, state.kind);
    }
  });
});

describe('remoteStateView: on somewhere', () => {
  it('is on in the window that holds Remote, whatever its link', () => {
    for (const state of ON_STATES) {
      assert.equal(remoteView.remoteStateView(view(state), setup).onSomewhere, true, state.kind);
    }
  });

  it('is on where another window holds it, and off when nobody does', () => {
    const elsewhere = view({ kind: 'elsewhere', holder: { label: 'api' } });
    assert.equal(remoteView.remoteStateView(elsewhere, setup).onSomewhere, true);
    assert.equal(remoteView.remoteStateView(view({ kind: 'off' }), setup).onSomewhere, false);
  });
});

describe('remoteStateView: a refused turn-on', () => {
  it('names the holder window, and turns the tone to fault with the switch off', () => {
    const holder = { label: 'api', folder: '/work/api' };
    const out = remoteView.remoteStateView(
      view(
        { kind: 'elsewhere', holder },
        { refused: { reason: link.heldIn('api'), holder, at: 1 } }
      ),
      setup
    );
    assert.equal(out.on, false);
    assert.equal(out.tone, 'fault');
    assert.equal(out.refused, 'Remote is on in api. Turn it off there first.');
    assert.equal(out.onSomewhere, true, 'the refusal hid that another window holds it');
  });

  it("draws any other refusal as M0's or M2's reason, as given", () => {
    const out = remoteView.remoteStateView(
      view({ kind: 'off' }, { refused: { reason: 'Remote needs the Bot token first.', at: 1 } }),
      setup
    );
    assert.equal(out.on, false);
    assert.equal(out.tone, 'fault');
    assert.equal(out.refused, 'Remote needs the Bot token first.');
  });
});

describe('remoteStateView: keep-awake', () => {
  it('warns that keep-awake is off, with a fix', () => {
    const out = remoteView.remoteStateView(
      view({ kind: 'connected', since: 1 }, { awake: 'off' }),
      setup
    );
    assert.deepEqual(out.warnings, [
      { text: 'Keep-awake is off, so this machine may sleep and miss messages.', fix: 'keepAwake' }
    ]);
  });

  for (const awake of ['idle', 'stale'] as const) {
    it(`warns that the Remote hold is off when nothing is held (${awake}), with a fix`, () => {
      const out = remoteView.remoteStateView(
        view({ kind: 'connected', since: 1 }, { awake, awakeRemote: false }),
        setup
      );
      assert.deepEqual(out.warnings, [
        {
          text: 'Keep-awake does not hold for Remote, so this machine may sleep and miss messages.',
          fix: 'awakeRemote'
        }
      ]);
    });
  }

  it('says nothing of an idle verdict while the Remote hold is on: the check has not caught up', () => {
    const out = remoteView.remoteStateView(
      view({ kind: 'connected', since: 1 }, { awake: 'idle' }),
      setup
    );
    assert.deepEqual(out.warnings, []);
  });

  it('warns about the battery, with no fix', () => {
    const out = remoteView.remoteStateView(
      view({ kind: 'connecting' }, { awake: 'battery' }),
      setup
    );
    assert.deepEqual(out.warnings, [
      { text: 'On battery, this machine is not being kept awake. Plug it in.' }
    ]);
  });

  it('warns that this machine cannot be kept awake, with no fix', () => {
    const out = remoteView.remoteStateView(
      view({ kind: 'failed', reason: 'x', retry: false }, { awake: 'unsupported' }),
      setup
    );
    assert.deepEqual(out.warnings, [
      {
        text: 'This machine cannot be kept awake from here, and may sleep while you are away.'
      }
    ]);
  });

  it('says nothing while the machine is being kept awake', () => {
    const out = remoteView.remoteStateView(
      view({ kind: 'connected', since: 1 }, { awake: 'drinking' }),
      setup
    );
    assert.deepEqual(out.warnings, []);
  });

  it('says nothing while Remote is off here, whatever keep-awake says', () => {
    for (const awake of ['off', 'battery', 'unsupported'] as const) {
      for (const state of [
        { kind: 'off' } as const,
        { kind: 'elsewhere', holder: { label: 'api' } } as const
      ]) {
        const out = remoteView.remoteStateView(view(state, { awake }), setup);
        assert.deepEqual(out.warnings, [], `${state.kind} ${awake}`);
      }
    }
  });
});

describe('remoteStateView: setup', () => {
  it('is ready when every field is set and an account is allowed', () => {
    assert.deepEqual(remoteView.remoteStateView(view({ kind: 'off' }), setup).missing, []);
  });

  it('names a field that is not set', () => {
    const out = remoteView.remoteStateView(view({ kind: 'off' }, { unset: 'app' }), setup);
    assert.deepEqual(out.missing, ['App token']);
  });

  it('asks for an allowed account when the list is empty', () => {
    const out = remoteView.remoteStateView(view({ kind: 'off' }, { allowlist: [] }), setup);
    assert.deepEqual(out.missing, ['an allowed account']);
  });

  it('says Not configured on the messenger while off and missing setup, naming what in its tip', () => {
    const out = remoteView.remoteStateView(view({ kind: 'off' }, { unset: 'app' }), setup);
    assert.deepEqual(out.messengers.state, {
      tone: 'unset',
      text: 'Not configured',
      tip: 'Needs App token'
    });
  });

  it('says the link on the messenger once setup is complete', () => {
    const out = remoteView.remoteStateView(view({ kind: 'off' }), setup);
    assert.deepEqual(out.messengers.state, { tone: 'off', text: 'Off' });
  });

  it('lets another window’s hold outrank missing setup on the messenger', () => {
    const out = remoteView.remoteStateView(
      view({ kind: 'elsewhere', holder: { label: 'api' } }, { unset: 'app' }),
      setup
    );
    assert.deepEqual(out.messengers.state, {
      tone: 'elsewhere',
      text: 'On in another window: api'
    });
  });

  it("copies the setup, with only whether a link exists and the copy button's label", () => {
    const out = remoteView.remoteStateView(view({ kind: 'off' }), setup);
    assert.deepEqual(out.setup, {
      messenger: 'Chat',
      fields: [
        { key: 'bot', label: 'Bot token', set: true },
        { key: 'app', label: 'App token', set: true }
      ],
      allowlist: ['T1:U1'],
      sender: { help: 'Your member id, from your profile.', placeholder: 'T…:U…' },
      create: {
        steps: [
          { title: 'Open it', text: 'Open the create page.' },
          { title: 'Paste it', text: 'Paste the manifest.' }
        ],
        copyLabel: 'Copy manifest',
        link: true
      }
    });
  });

  it("carries where each token comes from, in the messenger's words", () => {
    const helped: MessengerSetup = {
      ...setup,
      fields: [{ key: 'bot', label: 'Bot token', help: 'From the install page.' }, setup.fields[1]!]
    };
    const out = remoteView.remoteStateView(view({ kind: 'off' }), helped);
    assert.deepEqual(out.setup.fields, [
      { key: 'bot', label: 'Bot token', set: true, help: 'From the install page.' },
      { key: 'app', label: 'App token', set: true }
    ]);
  });

  it('carries no create section for an adapter with none', () => {
    const out = remoteView.remoteStateView(view({ kind: 'off' }), {
      fields: [],
      sender: { help: 'Any id.' }
    });
    assert.equal(out.setup.create, undefined);
  });

  it('leaves the manifest and the create URL off the wire, for every registered messenger', () => {
    assert.ok(
      !JSON.stringify(remoteView.remoteStateView(view({ kind: 'off' }), setup)).includes(MANIFEST)
    );
    assert.ok(
      !JSON.stringify(remoteView.remoteStateView(view({ kind: 'off' }), setup)).includes(CREATE_URL)
    );
    for (const entry of port.messengers()) {
      const json = JSON.stringify(remoteView.remoteStateView(view({ kind: 'off' }), entry.setup));
      const create = entry.setup.create;
      if (create?.copy) assert.ok(!json.includes(create.copy.text), entry.id);
      if (create?.link) assert.ok(!json.includes(create.link), entry.id);
    }
  });
});

describe('remoteStateView: messengers', () => {
  function on(id: string, label: string): link.RemoteView {
    const base = view({ kind: 'off' });
    return { ...base, setup: { ...base.setup, messenger: { id, label } } };
  }

  it('lists every listed messenger, and selects the current one', () => {
    const listed = port.messengers().filter((entry) => entry.listed);
    const first = listed[0];
    assert.ok(first);
    const out = remoteView.remoteStateView(on(first.id, first.label), first.setup);
    assert.deepEqual(
      out.messengers.rows.filter((row) => row.live).map((row) => row.id),
      listed.map((entry) => entry.id)
    );
    assert.equal(out.messengers.selected, first.id);
  });

  it('adds the current messenger when it is not listed, so its setup has a row', () => {
    const out = remoteView.remoteStateView(on('fake', 'Test messenger'), setup);
    const unlisted = out.messengers.rows.filter((row) => row.id === 'fake');
    assert.deepEqual(
      unlisted.map(({ label, live }) => ({ label, live })),
      [{ label: 'Test messenger', live: true }]
    );
    assert.equal(out.messengers.selected, 'fake');
    for (const entry of port.messengers().filter((e) => e.listed)) {
      assert.ok(
        out.messengers.rows.some((row) => row.id === entry.id),
        entry.id
      );
    }
  });
});

describe('remoteStateView: check', () => {
  it('reads a view with no check as never checked, every step still to do', () => {
    const out = remoteView.remoteStateView(view({ kind: 'off' }), setup);
    assert.equal(out.check.verdict, 'never');
    assert.deepEqual(out.check.marks, ['todo', 'todo']);
    assert.deepEqual(out.check.facts, []);
  });

  function checked(state: link.RemoteLink, check: link.CheckState): link.RemoteView {
    return { ...view(state), check };
  }

  const result = (found: SetupCheck): link.CheckState => ({
    kind: 'result',
    result: found,
    at: 5
  });

  const THREE: MessengerSetup = {
    ...setup,
    create: {
      steps: [
        { title: 'Make it', text: 'Make the app.' },
        { title: 'Token', text: 'Copy the token.' },
        { title: 'Install', text: 'Install it.' }
      ]
    }
  };

  it('says a check is running, every step still to do', () => {
    const out = remoteView.remoteStateView(checked({ kind: 'off' }, { kind: 'checking' }), setup);
    assert.deepEqual(out.check, {
      verdict: 'checking',
      text: 'Checking…',
      marks: ['todo', 'todo'],
      facts: []
    });
  });

  it('says an ok check is configured, every step done, with what it was told', () => {
    const facts = [{ label: 'Workspace', value: 'Acme' }];
    const out = remoteView.remoteStateView(
      checked({ kind: 'off' }, result({ kind: 'ok', facts })),
      setup
    );
    assert.deepEqual(out.check, {
      verdict: 'ok',
      text: 'Configured',
      marks: ['done', 'done'],
      facts,
      at: 5
    });
  });

  it('carries when a check that ran finished, whatever it found', () => {
    for (const found of [
      { kind: 'ok', facts: [] },
      { kind: 'setup', step: 0, reason: 'Redo it.' },
      { kind: 'unreachable', reason: 'Offline.' }
    ] satisfies SetupCheck[]) {
      const out = remoteView.remoteStateView(checked({ kind: 'off' }, result(found)), setup);
      assert.equal(out.check.at, 5, found.kind);
    }
  });

  it('carries no time when no check has finished', () => {
    for (const out of [
      remoteView.remoteStateView(view({ kind: 'off' }), setup),
      remoteView.remoteStateView(checked({ kind: 'off' }, { kind: 'checking' }), setup),
      remoteView.remoteStateView(view({ kind: 'connected', since: 1 }), setup)
    ]) {
      assert.equal('at' in out.check, false, out.check.verdict);
    }
  });

  it('marks the steps before a failed one done and the steps after it to do', () => {
    const out = remoteView.remoteStateView(
      checked(
        { kind: 'off' },
        result({ kind: 'setup', step: 1, reason: 'The token was refused.' })
      ),
      THREE
    );
    assert.equal(out.check.verdict, 'setup');
    assert.equal(out.check.text, 'The token was refused.');
    assert.deepEqual(out.check.marks, ['done', 'failed', 'todo']);
    assert.deepEqual(out.check.facts, []);
  });

  it('fails the first step with nothing done before it', () => {
    const out = remoteView.remoteStateView(
      checked({ kind: 'off' }, result({ kind: 'setup', step: 0, reason: 'Make the app first.' })),
      THREE
    );
    assert.deepEqual(out.check.marks, ['failed', 'todo', 'todo']);
  });

  it('blames no step when the messenger could not be asked, and says so', () => {
    const out = remoteView.remoteStateView(
      checked(
        { kind: 'off' },
        result({ kind: 'unreachable', reason: 'Chat could not be reached.' })
      ),
      THREE
    );
    assert.equal(out.check.verdict, 'unreachable');
    assert.equal(out.check.text, 'Chat could not be reached.');
    assert.deepEqual(out.check.marks, ['todo', 'todo', 'todo']);
  });

  it('keeps a connected link unchecked while no check has run', () => {
    const out = remoteView.remoteStateView(view({ kind: 'connected', since: 1 }), setup);
    assert.equal(out.check.verdict, 'never');
    assert.equal(out.check.text, 'Not checked');
    assert.deepEqual(out.check.marks, ['todo', 'todo']);
    assert.deepEqual(out.check.facts, []);
  });

  it('lets a check that has run speak over a connected link', () => {
    const out = remoteView.remoteStateView(
      checked(
        { kind: 'connected', since: 1 },
        result({ kind: 'setup', step: 1, reason: 'A scope is missing.' })
      ),
      setup
    );
    assert.equal(out.check.verdict, 'setup');
    assert.deepEqual(out.check.marks, ['done', 'failed']);
  });

  it('draws a check in flight over a connected link', () => {
    const out = remoteView.remoteStateView(
      checked({ kind: 'connected', since: 1 }, { kind: 'checking' }),
      setup
    );
    assert.equal(out.check.verdict, 'checking');
  });

  it('reads no other link state as a verdict', () => {
    for (const state of ON_STATES.filter((one) => one.kind !== 'connected')) {
      const out = remoteView.remoteStateView(view(state), setup);
      assert.equal(out.check.verdict, 'never', state.kind);
    }
  });

  it('leaves the manifest and the create URL off the wire whatever the check found', () => {
    for (const check of [
      { kind: 'checking' } as const,
      result({ kind: 'ok', facts: [{ label: 'Bot', value: '@squadron' }] }),
      result({ kind: 'setup', step: 0, reason: 'Redo it.' }),
      result({ kind: 'unreachable', reason: 'Offline.' })
    ]) {
      const json = JSON.stringify(
        remoteView.remoteStateView(checked({ kind: 'off' }, check), setup)
      );
      assert.ok(!json.includes(MANIFEST), check.kind);
      assert.ok(!json.includes(CREATE_URL), check.kind);
    }
  });

  it('names none of our boxes in any sentence of its own', () => {
    const texts = [{ kind: 'never' } as const, { kind: 'checking' } as const].map(
      (check) => remoteView.remoteStateView(checked({ kind: 'off' }, check), setup).check.text
    );
    texts.push(
      remoteView.remoteStateView(view({ kind: 'connected', since: 1 }), setup).check.text,
      remoteView.remoteStateView(checked({ kind: 'off' }, result({ kind: 'ok', facts: [] })), setup)
        .check.text
    );
    const boxes = /\b(sheet|bar|dock|panel|card|board|tab)s?\b/i;
    assert.deepEqual(
      texts.filter((text) => boxes.test(text)),
      []
    );
  });
});

describe('remoteStateView: messengers not built yet', () => {
  it('draws Discord and Telegram as rows that cannot be picked, each with its tip', () => {
    const out = remoteView.remoteStateView(view({ kind: 'off' }), setup);
    const later = out.messengers.rows.filter((row) => !row.live);
    assert.deepEqual(
      later.map((row) => row.id),
      ['discord', 'telegram']
    );
    for (const row of later) assert.ok(row.tip && row.tip.length > 0, row.id);
    assert.match(later[0]?.tip ?? '', /D29/);
    assert.match(later[1]?.tip ?? '', /D28/);
  });

  it('lists them after every messenger that works', () => {
    const out = remoteView.remoteStateView(view({ kind: 'off' }), setup);
    const live = out.messengers.rows.map((row) => row.live);
    assert.deepEqual(
      live,
      [...live].sort((a, b) => Number(b) - Number(a))
    );
  });

  it('never selects one', () => {
    const out = remoteView.remoteStateView(view({ kind: 'off' }), setup);
    const selected = out.messengers.rows.find((row) => row.id === out.messengers.selected);
    assert.equal(selected?.live, true);
  });
});

describe('allowlistNotSaved', () => {
  it("says the accounts were not saved, with the host's reason", () => {
    assert.equal(
      remoteView.allowlistNotSaved('Unable to write into user settings.'),
      'The allowed accounts were not saved: Unable to write into user settings.'
    );
  });

  it('says only that they were not saved when the reason could not be redacted', () => {
    assert.equal(remoteView.allowlistNotSaved(undefined), 'The allowed accounts were not saved.');
  });
});

describe('remoteStateView: words', () => {
  it('names none of our boxes in any string it composes', () => {
    const holder = { label: 'api', folder: '/work/api' };
    const states: link.RemoteLink[] = [
      { kind: 'off' },
      { kind: 'off', reason: link.holderLost(holder) },
      { kind: 'off', reason: link.holderLost(undefined) },
      { kind: 'elsewhere', holder },
      { kind: 'elsewhere', holder: { label: '' } },
      ...ON_STATES
    ];
    const refusals: (link.Refused | undefined)[] = [
      undefined,
      { reason: link.heldIn('api'), holder, at: 1 },
      { reason: link.heldIn(''), at: 1 }
    ];
    const awakes: (AwakeReason | undefined)[] = [
      undefined,
      'drinking',
      'idle',
      'stale',
      'battery',
      'off',
      'unsupported'
    ];
    const words: string[] = [];
    for (const state of states) {
      for (const refused of refusals) {
        for (const awake of awakes) {
          for (const extra of [{}, { allowlist: [] }, { unset: 'bot' }]) {
            const out = remoteView.remoteStateView(
              view(state, {
                ...extra,
                ...(refused ? { refused } : {}),
                ...(awake ? { awake } : {})
              }),
              setup
            );
            words.push(
              out.status,
              ...[out.reason, out.refused, out.hint].filter((w): w is string => w !== undefined),
              ...out.warnings.map((w) => w.text),
              ...out.missing
            );
          }
        }
      }
    }
    const boxes = /\b(sheet|bar|dock|panel|card|board|tab)s?\b/i;
    assert.deepEqual(
      [...new Set(words)].filter((w) => boxes.test(w)),
      []
    );
  });
});

describe('remoteStateView: accounts and the space', () => {
  const spaced: MessengerSetup = {
    ...setup,
    sender: {
      ...setup.sender,
      space: { label: 'Workspace', help: 'Check fills it in.', placeholder: 'T0123ABCD' }
    }
  };

  function viewWith(over: Partial<link.RemoteSetup>, check?: link.CheckState): link.RemoteView {
    const base = view({ kind: 'off' });
    return { ...base, setup: { ...base.setup, ...over }, ...(check ? { check } : {}) };
  }

  it('words each account it cannot use: the messenger’s reason, or the space it waits on', () => {
    const out = remoteView.remoteStateView(
      viewWith({
        allowlist: ['bob@x', 'U1', 'T1:U2'],
        unusable: [
          { account: 'bob@x', problem: { kind: 'refused', reason: 'Not a member id.' } },
          { account: 'U1', problem: { kind: 'space' } }
        ],
        space: {}
      }),
      spaced
    );
    assert.deepEqual(out.setup.unusable, [
      { account: 'bob@x', reason: 'Not a member id.' },
      { account: 'U1', reason: 'Waiting on the Workspace: press Check, or set it.' }
    ]);
    assert.deepEqual(out.missing, []);
  });

  it('asks for the space, not an account, when every account waits on it', () => {
    const out = remoteView.remoteStateView(
      viewWith({
        allowlist: ['U1'],
        unusable: [{ account: 'U1', problem: { kind: 'space' } }],
        space: {}
      }),
      spaced
    );
    assert.deepEqual(out.missing, ['Workspace']);
  });

  it('says to change a space it cannot use, which no check replaces', () => {
    const out = remoteView.remoteStateView(
      viewWith({
        allowlist: ['U1'],
        unusable: [{ account: 'U1', problem: { kind: 'space' } }],
        space: { value: 't0abc', refused: 'A workspace id starts with T.' }
      }),
      spaced
    );
    assert.deepEqual(out.setup.unusable, [
      { account: 'U1', reason: 'Waiting on the Workspace, which cannot be used: change it.' }
    ]);
    assert.deepEqual(out.missing, ['Workspace']);
  });

  it('asks for an account when every stored one is refused', () => {
    const out = remoteView.remoteStateView(
      viewWith({
        allowlist: ['bob@x'],
        unusable: [{ account: 'bob@x', problem: { kind: 'refused', reason: 'No.' } }]
      }),
      setup
    );
    assert.deepEqual(out.missing, ['an allowed account']);
  });

  it('draws the space row in the messenger’s words, with the value set', () => {
    const out = remoteView.remoteStateView(viewWith({ space: { value: 'T0SQUAD01' } }), spaced);
    assert.deepEqual(out.setup.space, {
      label: 'Workspace',
      help: 'Check fills it in.',
      placeholder: 'T0123ABCD',
      value: 'T0SQUAD01'
    });
  });

  it('says why a stored space cannot be used', () => {
    const out = remoteView.remoteStateView(
      viewWith({ space: { value: 'squad', refused: 'A workspace id starts with T.' } }),
      spaced
    );
    assert.equal(out.setup.space?.problem, 'A workspace id starts with T.');
  });

  it('offers what the last ok check found when it differs from the space set', () => {
    const found: link.CheckState = {
      kind: 'result',
      result: { kind: 'ok', facts: [], space: 'T0OTHER01' },
      at: 1
    };
    const differs = remoteView.remoteStateView(
      viewWith({ space: { value: 'T0SQUAD01' } }, found),
      spaced
    );
    assert.equal(differs.setup.space?.found, 'T0OTHER01');
    const same = remoteView.remoteStateView(
      viewWith({ space: { value: 'T0OTHER01' } }, found),
      spaced
    );
    assert.equal(same.setup.space?.found, undefined);
  });

  it('draws no space row for a messenger with none', () => {
    const out = remoteView.remoteStateView(viewWith({}), setup);
    assert.equal(out.setup.space, undefined);
    assert.equal(out.setup.unusable, undefined);
  });
});

describe('accountsNotAdded', () => {
  it('names the account, then the messenger’s reason', () => {
    assert.equal(
      remoteView.accountsNotAdded([{ account: 'bob@x', reason: 'A member id starts with U.' }]),
      'bob@x was not added. A member id starts with U.'
    );
  });

  it('names every account refused in one edit, each with its reason', () => {
    assert.equal(
      remoteView.accountsNotAdded([
        { account: 'bob@x', reason: 'Not an email.' },
        { account: 'T1', reason: 'A workspace id.' }
      ]),
      'bob@x was not added. Not an email. T1 was not added. A workspace id.'
    );
  });
});
