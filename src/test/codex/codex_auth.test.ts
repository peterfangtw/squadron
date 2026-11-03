import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import type { LoginEvent } from '../../core/accounts';
import {
  codexAuthLogout,
  codexAuthStamp,
  codexAuthStatus,
  codexPlanLabel,
  parseCodexAuthStatus,
  parseCodexLoginStart,
  refreshCodexCatalog,
  startCodexLogin
} from '../../core/codex/auth';
import { codexModels, resetCodexModelsForTest } from '../../core/codex/models';
import type { CodexConnection, CodexConnector, CodexRpc } from '../../core/codex/runtime';

class FakeRpc implements CodexRpc {
  readonly calls: { method: string; params?: unknown }[] = [];
  private notifications = new Set<(method: string, params: unknown) => void>();

  constructor(private readonly answer: (method: string, params?: unknown) => unknown) {}

  request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, ...(params === undefined ? {} : { params }) });
    try {
      return Promise.resolve(this.answer(method, params));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  notify(): void {}

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  emit(method: string, params: unknown): void {
    for (const listener of this.notifications) listener(method, params);
  }
}

function connected(rpc: FakeRpc): {
  connector: CodexConnector;
  connection: CodexConnection;
  closed: () => number;
  exit: () => void;
} {
  let closes = 0;
  let onExit = (): void => {};
  const connection: CodexConnection = {
    client: rpc,
    onExit: (listener) => {
      onExit = listener;
    },
    close: () => {
      closes += 1;
    }
  };
  return {
    connection,
    connector: () => Promise.resolve({ ok: true, connection }),
    closed: () => closes,
    exit: () => onExit()
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const model = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  model: id,
  displayName: id.toUpperCase(),
  hidden: false,
  isDefault: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'fixture' }],
  defaultReasoningEffort: 'medium',
  inputModalities: ['text', 'image'],
  ...over
});

describe('Codex account parsing', () => {
  it('uses account null as signed out and never requiresOpenaiAuth as identity', () => {
    assert.deepEqual(parseCodexAuthStatus({ account: null, requiresOpenaiAuth: true }), {
      loggedIn: false
    });
  });

  it('retains only display-safe ChatGPT account facts', () => {
    assert.deepEqual(
      parseCodexAuthStatus({
        account: { type: 'chatgpt', email: ' reader@example.com ', planType: 'plus', token: 'no' },
        requiresOpenaiAuth: true
      }),
      { loggedIn: true, mode: 'chatgpt', email: 'reader@example.com', plan: 'Plus' }
    );
    assert.equal(parseCodexAuthStatus({ account: { type: 'future-provider' } }), undefined);
  });

  it('names every Codex 0.150 plan slug, and the two that carry a multiplier', () => {
    assert.equal(codexPlanLabel('pro'), 'Pro 20x');
    assert.equal(codexPlanLabel('prolite'), 'Pro 5x');
    for (const [slug, label] of [
      ['free', 'Free'],
      ['go', 'Go'],
      ['plus', 'Plus'],
      ['team', 'Team'],
      ['self_serve_business_prolite', 'Business'],
      ['self_serve_business_usage_based', 'Business'],
      ['business', 'Business'],
      ['ent26', 'Enterprise'],
      ['enterprise_cbp_automation', 'Enterprise'],
      ['enterprise_cbp_usage_based', 'Enterprise'],
      ['enterprise', 'Enterprise'],
      ['edu', 'Edu'],
      ['edu_plus', 'Edu'],
      ['edu_pro', 'Edu']
    ] as const) {
      assert.equal(codexPlanLabel(slug), label, slug);
    }
  });

  it('draws no chip for a plan this table does not name', () => {
    assert.equal(codexPlanLabel('unknown'), undefined);
    assert.equal(codexPlanLabel(undefined), undefined);
    assert.equal(codexPlanLabel('  '), undefined);
    // A slug added after this table is the same answer by another route: omit
    // the badge rather than state `Ultra Max`, a tier nobody sells.
    assert.equal(codexPlanLabel('ultra_max'), undefined);
    assert.deepEqual(parseCodexAuthStatus({ account: { type: 'chatgpt', planType: 'unknown' } }), {
      loggedIn: true,
      mode: 'chatgpt'
    });
  });

  it('parses both observed login start variants', () => {
    assert.deepEqual(
      parseCodexLoginStart({
        type: 'chatgptDeviceCode',
        loginId: 'login-1',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH'
      }),
      {
        loginId: 'login-1',
        url: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH'
      }
    );
    assert.deepEqual(
      parseCodexLoginStart({ type: 'chatgpt', loginId: 'login-2', authUrl: 'https://auth' }),
      { loginId: 'login-2', url: 'https://auth' }
    );
  });

  it('sends logout with no params and closes the private server', async () => {
    const rpc = new FakeRpc(() => ({}));
    const peer = connected(rpc);
    assert.deepEqual(await codexAuthLogout(undefined, peer.connector), { ok: true });
    assert.deepEqual(rpc.calls, [{ method: 'account/logout' }]);
    assert.equal(peer.closed(), 1);
  });
});

describe('Codex managed login', () => {
  it('buffers a completion delivered in the same batch as the start response', async () => {
    const rpc = new FakeRpc((method) => {
      if (method === 'account/login/start') {
        rpc.emit('account/login/completed', { loginId: 'login-batch', success: true });
        return {
          type: 'chatgptDeviceCode',
          loginId: 'login-batch',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-EFGH'
        };
      }
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'model/list') return { data: [] };
      return {};
    });
    const peer = connected(rpc);
    const events: LoginEvent[] = [];
    await startCodexLogin((event) => events.push(event), undefined, peer.connector);
    rpc.emit('account/updated', { authMode: 'chatgpt' });
    await tick();
    assert.equal(
      events.some((event) => event.type === 'phase' && event.phase === 'done'),
      true
    );
    assert.equal(peer.closed(), 1);
  });

  it('settles once on correlated completion, without waiting for an account update', async () => {
    const rpc = new FakeRpc((method) => {
      if (method === 'account/login/start') {
        return {
          type: 'chatgptDeviceCode',
          loginId: 'login-1',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-EFGH'
        };
      }
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'a@b.c' } };
      if (method === 'model/list') return { data: [] };
      return {};
    });
    const peer = connected(rpc);
    const events: LoginEvent[] = [];
    const session = await startCodexLogin((event) => events.push(event), undefined, peer.connector);
    assert.ok(!('ok' in session));
    rpc.emit('account/login/completed', { loginId: 'other', success: true });
    await tick();
    assert.equal(
      events.some((event) => event.type === 'phase' && event.phase === 'done'),
      false,
      'an uncorrelated completion settles nothing'
    );
    // `account/updated` is a hint that the read will succeed, not a precondition
    // for it: a correlated completion plus an authoritative `account/read` is
    // the whole of the evidence, and waiting for an update the server may emit
    // first — or not at all — is what hung this flow until the deadline.
    rpc.emit('account/login/completed', { loginId: 'login-1', success: true });
    await tick();
    assert.equal(
      events.filter((event) => event.type === 'phase' && event.phase === 'done').length,
      1
    );
    rpc.emit('account/updated', { authMode: 'chatgpt' });
    await tick();
    assert.equal(
      events.filter((event) => event.type === 'phase' && event.phase === 'done').length,
      1,
      'a later update does not settle a second time'
    );
    assert.equal(peer.closed(), 1);
  });

  it('settles on an account update when the account is not readable yet', async () => {
    let ready = false;
    const rpc = new FakeRpc((method) => {
      if (method === 'account/login/start') {
        return {
          type: 'chatgptDeviceCode',
          loginId: 'login-slow',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-EFGH'
        };
      }
      if (method === 'account/read') return ready ? { account: { type: 'chatgpt' } } : {};
      if (method === 'model/list') return { data: [] };
      return {};
    });
    const peer = connected(rpc);
    const events: LoginEvent[] = [];
    await startCodexLogin((event) => events.push(event), undefined, peer.connector);
    rpc.emit('account/login/completed', { loginId: 'login-slow', success: true });
    await tick();
    // A read taken before the update is not an authoritative no, so this neither
    // settles nor fails — it waits, and the deadline is what backstops it.
    assert.equal(
      events.some((event) => event.type === 'phase' && event.phase === 'done'),
      false
    );
    assert.equal(
      events.some((event) => event.type === 'phase' && event.phase === 'error'),
      false
    );
    ready = true;
    rpc.emit('account/updated', { authMode: 'chatgpt' });
    await tick();
    assert.equal(
      events.filter((event) => event.type === 'phase' && event.phase === 'done').length,
      1
    );
  });

  it('recovers an account update that arrived while the re-read was in flight', async () => {
    // The lost wakeup: `verify` is awaiting `account/read`, the update lands and
    // is dropped by the re-entrancy guard, and the read it was racing comes back
    // stale. Nothing else is holding a retry, so without one the flow parks
    // until the ten-minute deadline on a login that actually worked.
    let release: (value: unknown) => void = () => {};
    let reads = 0;
    const rpc = new FakeRpc((method) => {
      if (method === 'account/login/start') {
        return {
          type: 'chatgptDeviceCode',
          loginId: 'login-race',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-EFGH'
        };
      }
      if (method === 'account/read') {
        reads += 1;
        if (reads === 1) return new Promise((resolve) => (release = resolve));
        return { account: { type: 'chatgpt' } };
      }
      if (method === 'model/list') return { data: [] };
      return {};
    });
    const peer = connected(rpc);
    const events: LoginEvent[] = [];
    await startCodexLogin((event) => events.push(event), undefined, peer.connector);
    rpc.emit('account/login/completed', { loginId: 'login-race', success: true });
    await tick();
    assert.equal(reads, 1, 'the completion alone starts the re-read');
    rpc.emit('account/updated', { authMode: 'chatgpt' });
    await tick();
    // Still one read: the update found `verifying` set and returned.
    assert.equal(reads, 1);
    release({});
    await tick();
    assert.equal(reads, 2, 'the dropped update is recovered as a second read');
    assert.equal(
      events.filter((event) => event.type === 'phase' && event.phase === 'done').length,
      1
    );
  });

  it('cancels by login id without painting the expected failed completion', async () => {
    const rpc = new FakeRpc((method) =>
      method === 'account/login/start'
        ? {
            type: 'chatgptDeviceCode',
            loginId: 'login-1',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'ABCD-EFGH'
          }
        : {}
    );
    const peer = connected(rpc);
    const events: LoginEvent[] = [];
    const session = await startCodexLogin((event) => events.push(event), undefined, peer.connector);
    assert.ok(!('ok' in session));
    session.cancel();
    rpc.emit('account/login/completed', {
      loginId: 'login-1',
      success: false,
      error: 'Login was not completed'
    });
    await tick();
    assert.deepEqual(rpc.calls.at(-1), {
      method: 'account/login/cancel',
      params: { loginId: 'login-1' }
    });
    assert.equal(
      events.some((event) => event.type === 'error'),
      false
    );
    assert.equal(peer.closed(), 1);
  });

  it('times out a flow missing completion and closes once', async () => {
    const rpc = new FakeRpc((method) =>
      method === 'account/login/start'
        ? {
            type: 'chatgptDeviceCode',
            loginId: 'login-timeout',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'ABCD-EFGH'
          }
        : {}
    );
    const peer = connected(rpc);
    const events: LoginEvent[] = [];
    const session = await startCodexLogin(
      (event) => events.push(event),
      undefined,
      peer.connector,
      5
    );
    assert.ok(!('ok' in session));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(events.filter((event) => event.type === 'error').length, 1);
    assert.equal(peer.closed(), 1);
  });

  it('ignores account updates that precede correlated completion', async () => {
    const rpc = new FakeRpc((method) => {
      if (method === 'account/login/start') {
        return {
          type: 'chatgptDeviceCode',
          loginId: 'login-order',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-EFGH'
        };
      }
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'model/list') return { data: [] };
      return {};
    });
    const peer = connected(rpc);
    const events: LoginEvent[] = [];
    await startCodexLogin((event) => events.push(event), undefined, peer.connector);
    rpc.emit('account/updated', { authMode: 'unrelated' });
    await tick();
    assert.equal(
      events.some((event) => event.type === 'phase' && event.phase === 'done'),
      false,
      'an update before the correlated completion is not evidence of this login'
    );
    rpc.emit('account/login/completed', { loginId: 'login-order', success: true });
    await tick();
    assert.equal(
      events.filter((event) => event.type === 'phase' && event.phase === 'done').length,
      1
    );
  });

  it('reports child exit once after the session is handed off', async () => {
    const rpc = new FakeRpc((method) =>
      method === 'account/login/start'
        ? {
            type: 'chatgptDeviceCode',
            loginId: 'login-exit',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'ABCD-EFGH'
          }
        : {}
    );
    const peer = connected(rpc);
    const events: LoginEvent[] = [];
    await startCodexLogin((event) => events.push(event), undefined, peer.connector);
    peer.exit();
    peer.exit();
    assert.equal(events.filter((event) => event.type === 'error').length, 1);
    assert.equal(peer.closed(), 1);
  });
});

describe('codexAuthStamp', () => {
  it('moves when auth.json is rewritten or removed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-stamp-'));
    const file = path.join(dir, 'auth.json');
    const absent = await codexAuthStamp(file);
    await fs.writeFile(file, '{"auth_mode":"chatgpt"}');
    const first = await codexAuthStamp(file);
    assert.equal(await codexAuthStamp(file), first);
    await fs.writeFile(file, '{"auth_mode":"chatgpt","last_refresh":"2026-10-05"}');
    const refreshed = await codexAuthStamp(file);
    await fs.rm(file);
    assert.equal(new Set([absent, first, refreshed]).size, 3);
    assert.equal(await codexAuthStamp(file), absent);
  });
});

describe('Codex status and catalog reads', () => {
  const signedIn = { account: { type: 'chatgpt', email: 'a@example.com', planType: 'plus' } };

  it('reads the account without listing models when asked for status alone', async () => {
    resetCodexModelsForTest();
    const rpc = new FakeRpc((method) => {
      if (method === 'account/read') return signedIn;
      throw new Error(`unexpected ${method}`);
    });
    const status = await codexAuthStatus(undefined, connected(rpc).connector, false);
    assert.equal(status?.loggedIn, true);
    assert.deepEqual(
      rpc.calls.map((call) => call.method),
      ['account/read']
    );
  });

  it('says a catalog refresh failed when the app-server would not start', async () => {
    resetCodexModelsForTest();
    const rpc = new FakeRpc((method) =>
      method === 'account/read' ? signedIn : { data: [model('gpt-6.1-sol')] }
    );
    assert.equal(await refreshCodexCatalog(undefined, connected(rpc).connector), true);
    // The old account's rows are still held; a refresh that never reached the
    // server must not report them as the new account's.
    assert.ok(codexModels().length > 0);
    const refused: CodexConnector = () => Promise.resolve({ ok: false, reason: 'no codex' });
    assert.equal(await refreshCodexCatalog(undefined, refused), false);
  });
});
