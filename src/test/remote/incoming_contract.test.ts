import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import * as fixture from '../incoming_helpers';
import { tempHome } from '../helpers';

let incoming: typeof import('../../core/incoming');
before(async () => {
  await tempHome();
  incoming = await import('../../core/incoming');
});

describe('immutable incoming admission', () => {
  it('bounds UTF-8 provenance, normalizes optional metadata and deduplicates before disclosing extras', () => {
    const file = fixture.admission.files[0]!;
    const raw = {
      version: 1,
      installId: 'install',
      omitted: 0,
      files: [
        { ...file, id: 'é'.repeat(128), name: 'é'.repeat(257), mime: 'bad\nMIME', size: -1 },
        ...Array.from({ length: 11 }, (_, i) => ({ ...file, id: `file${i}` })),
        { ...file, id: 'file0' }
      ]
    };
    const decoded = incoming.readIncomingDescriptors(raw);
    assert.ok(decoded && !('denied' in decoded));
    assert.equal(decoded.files.length, 10);
    assert.equal(decoded.omitted, 2);
    assert.deepEqual(decoded.files[0], {
      id: 'é'.repeat(128),
      source: file.source,
      cacheKey: file.cacheKey
    });
    assert.ok(Object.isFrozen(decoded.files));
    assert.throws(() => {
      (decoded.files[0] as { id: string }).id = 'changed';
    }, TypeError);
    for (const invalid of [
      { ...file, id: 'é'.repeat(129) },
      { ...file, id: '\ud800' },
      { ...file, source: 'a'.repeat(2049) },
      { ...file, cacheKey: '../neighbor' },
      { ...file, id: 'bad\u0085id' },
      { ...file, source: '' }
    ])
      assert.deepEqual(incoming.readIncomingDescriptors({ ...raw, files: [invalid] }), {
        version: 1,
        denied: 'admission-denied'
      });
    assert.deepEqual(
      incoming.readIncomingDescriptors({ ...raw, files: [file, { ...file, source: 'different' }] }),
      { version: 1, denied: 'admission-denied' }
    );
    assert.deepEqual(
      incoming.readIncomingDescriptors({
        ...raw,
        files: [file, { ...file, cacheKey: 'different' }]
      }),
      { version: 1, denied: 'admission-denied' }
    );
    assert.deepEqual(incoming.readIncomingDescriptors({ ...raw, extra: 'x'.repeat(65_536) }), {
      version: 1,
      denied: 'admission-denied'
    });
    const large = incoming.readIncomingDescriptors({
      ...raw,
      files: [{ ...file, size: 10 * 1024 * 1024 + 1 }]
    });
    assert.ok(large && !('denied' in large));
    assert.equal(
      large.files[0]?.size,
      10 * 1024 * 1024 + 1,
      'size is retained for a later per-file refusal'
    );
  });

  it('uses an independent fixed tuple digest and denies changed provenance or order', () => {
    const digest = incoming.admissionDigest(fixture.admission);
    assert.equal(digest, '7c3854de67cf85f31d7f0247356d46e2b640d4cc0b8438b643652afaaa156ece');
    const reordered = Object.fromEntries(Object.entries(fixture.admission).reverse());
    assert.deepEqual(incoming.readIncomingAdmission({ ...reordered, digest }), {
      ...fixture.admission,
      digest
    });
    assert.equal(incoming.readIncomingAdmission(undefined), undefined);
    for (const change of [
      { senderId: 'different' },
      { installId: 'different' },
      { eventAt: 1001 },
      { files: [...fixture.admission.files, { ...fixture.admission.files[0], id: 'extra' }] },
      { version: 2 },
      { digest: 'wrong' },
      { senderId: 'é'.repeat(129) }
    ])
      assert.deepEqual(
        incoming.readIncomingAdmission({ ...fixture.admission, digest, ...change }),
        { version: 1, denied: 'admission-denied' }
      );
    const pair = {
      ...fixture.admission,
      files: [...fixture.admission.files, { ...fixture.admission.files[0]!, id: 'second' }]
    };
    const pairDigest = incoming.admissionDigest(pair);
    assert.deepEqual(
      incoming.readIncomingAdmission({
        ...pair,
        digest: pairDigest,
        files: [...pair.files].reverse()
      }),
      { version: 1, denied: 'admission-denied' }
    );
    assert.deepEqual(incoming.readIncomingAdmission({ version: 1, denied: 'admission-denied' }), {
      version: 1,
      denied: 'admission-denied'
    });
  });
});

describe('exact owner and stable evidence codecs', () => {
  it('keeps OS identity distinct from routing tolerance and mutable session IDs for every brand', () => {
    for (const brand of ['claude', 'grok', 'codex'] as const) {
      const receiver = incoming.readReceiverIdentity({
        ...fixture.receiver,
        brand,
        currentSessionId: 'old'
      });
      assert.ok(receiver);
      assert.equal(
        incoming.sameReceiver(receiver, { ...receiver, osStartedAt: receiver.osStartedAt + 1 }),
        false
      );
      assert.equal(
        incoming.sameReceiver(receiver, { ...receiver, incarnation: fixture.UUID }),
        false
      );
      assert.equal(
        incoming.sameReceiver(receiver, {
          ...receiver,
          host: { ...receiver.host, incarnation: fixture.OTHER_UUID }
        }),
        false
      );
      assert.deepEqual(
        incoming.readReceiverIdentity({ ...receiver, currentSessionId: 'clear' }),
        receiver
      );
    }
    for (const change of [
      { version: 2 },
      { startSource: 'heartbeat' },
      { osStartedAt: 1.5 },
      { incarnation: 'pid' },
      { pid: 0 }
    ])
      assert.equal(incoming.readHostIdentity({ ...fixture.host, ...change }), undefined);
    assert.equal(
      incoming.readHostIdentity({ ...fixture.host, extra: 'x'.repeat(65_536) }),
      undefined
    );
    assert.equal(
      incoming.readReceiverIdentity({
        ...fixture.receiver,
        cwd: path.join(fixture.receiver.cwd, '..') + path.sep
      }),
      undefined
    );
  });

  it('requires matching destination, receiver, digest, stage and challenged query', () => {
    assert.deepEqual(incoming.readRemoteLaunchEvidence(fixture.launch), fixture.launch);
    assert.equal(
      incoming.readRemoteLaunchEvidence({
        ...fixture.launch,
        receiver: { ...fixture.receiver, host: fixture.holder.host }
      }),
      undefined
    );
    assert.equal(
      incoming.readRemoteLaunchEvidence({ ...fixture.launch, marker: fixture.OTHER_UUID }),
      undefined
    );
    assert.equal(
      incoming.readLaunchAttempt({ ...fixture.attempt, selection: undefined }),
      undefined
    );
    assert.ok(incoming.readLaunchAttempt({ ...fixture.attempt, selection: 'default', target: {} }));
    const evidence = {
      version: 1,
      challenge: fixture.OTHER_UUID,
      host: fixture.host,
      query: { kind: 'attempt', attempt: fixture.attempt },
      receiver: fixture.receiver,
      currentSessionId: 'current',
      launch: fixture.launch
    };
    assert.deepEqual(incoming.readIncomingEvidence(evidence), evidence);
    assert.equal(
      incoming.readIncomingEvidence({
        ...evidence,
        launch: {
          ...fixture.launch,
          attempt: { ...fixture.attempt, admissionDigest: 'b'.repeat(64) }
        }
      }),
      undefined
    );
    assert.equal(
      incoming.readIncomingEvidence({
        ...evidence,
        host: { ...fixture.host, incarnation: fixture.OTHER_UUID }
      }),
      undefined
    );
    const delivery = { ...fixture.delivery, outcome: 'queued', acceptedAt: 4000 };
    const delivered = {
      ...evidence,
      query: { kind: 'delivery', delivery: fixture.delivery },
      delivery,
      launch: undefined
    };
    assert.ok(incoming.readIncomingEvidence(delivered));
    assert.equal(
      incoming.readIncomingEvidence({
        ...delivered,
        delivery: { ...delivery, correlation: 'other' }
      }),
      undefined
    );
  });

  it('refuses malformed, oversized and neighboring-path fetch replies before they can print success', () => {
    const localRoot = path.resolve('/managed');
    const fetched = {
      version: 1,
      requestId: fixture.UUID,
      identity: fixture.fetchIdentity,
      kind: 'fetched',
      cacheKey: 'provider_file',
      bytes: 0,
      path: path.join(localRoot, 'file'),
      localRoot,
      expiresAt: 5000
    };
    assert.deepEqual(incoming.readFetchFileReply(fetched), fetched);
    for (const change of [
      { version: 2 },
      { bytes: -1 },
      { bytes: 10 * 1024 * 1024 + 1 },
      { path: localRoot },
      { path: path.resolve('/managed-other/file') },
      { cacheKey: '../file' },
      { name: 'é'.repeat(257) },
      { expiresAt: NaN },
      { extra: 'x'.repeat(65_536) }
    ])
      assert.equal(incoming.readFetchFileReply({ ...fetched, ...change }), undefined);
    assert.ok(
      incoming.readFetchFileReply({
        version: 1,
        requestId: fixture.UUID,
        identity: fixture.fetchIdentity,
        kind: 'pending',
        retryable: true
      })
    );
    assert.equal(
      incoming.readFetchFileReply({
        version: 1,
        requestId: fixture.UUID,
        identity: fixture.fetchIdentity,
        kind: 'pending',
        retryable: false
      }),
      undefined
    );
    assert.equal(incoming.incomingRefusal('provider-secret/token'), false);
    assert.equal(incoming.incomingRefusal('provider-missing-scope'), true);
  });
});
