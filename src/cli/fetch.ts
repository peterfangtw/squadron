import * as gate from './gate';
import * as help from './help';
import { askExit } from '../core/coordination/ask';
import * as crypto from 'crypto';
import * as path from 'path';
import * as incoming from '../core/incoming';
import * as platform from '../core/platform';
import type { Checked, Fault } from '../core/platform/private_files';
import * as cache from '../core/remote/incoming_cache';
import * as holder from '../core/remote/holder';
import * as store from '../core/bridge/store';
import * as requests from '../core/coordination/requests';
import * as facts from '../core/message_facts';
import * as args from './args';
import * as self from './self';
import * as inputFile from './input_file';
import type {
  FetchFileIdentity,
  FetchFileReply,
  IncomingAdmission,
  IncomingFile
} from '../core/bridge/model';

export const FLAGS = ['conversation-id', 'message-id', 'file-id'] as const;

/** Each names an id, so `--file-id` is never mistaken for `squadron-attach`'s `--file-path`. */
const RENAMED: args.Renamed<typeof FLAGS> = {
  conversation: 'conversation-id',
  message: 'message-id',
  file: 'file-id'
};
type Options = args.Flags<typeof FLAGS>;
const USAGE =
  'usage: squadron-fetch-file --conversation-id <original conversation> --message-id <message correlation> --file-id <file ID>';
export type FetchPlan =
  | { ok: true; identity: FetchFileIdentity; admission: IncomingAdmission; file: IncomingFile }
  | { ok: false; code: 1 | 2 | 3 | 4 | 5; reason: string };

export function fetchPlan(
  opts: Options
): { conversation: string; correlation: string; fileId: string } | undefined {
  const conversation = opts['conversation-id'];
  const correlation = opts['message-id'];
  const fileId = opts['file-id'];
  return incoming.incomingString(conversation) &&
    facts.isCorrelation(correlation) &&
    incoming.incomingString(correlation, 128) &&
    incoming.incomingString(fileId)
    ? { conversation, correlation, fileId }
    : undefined;
}

export async function readPlan(opts: Options): Promise<FetchPlan> {
  const original = fetchPlan(opts);
  if (!original) return { ok: false, code: 1, reason: USAGE };
  const resolved = await self.resolveOwnedSelf();
  if (!resolved.ok) return resolved;
  const current = await holder.readHolder(resolved.table);
  const holding = current?.incoming;
  if (
    !holding ||
    current.windowId !== holding.host.windowId ||
    resolved.table.starts.get(holding.host.pid) !== holding.host.osStartedAt
  )
    return { ok: false, code: 2, reason: 'Remote has no live incoming-file holder' };
  const conversation = await store.readStoredConversation(original.conversation);
  const messages = conversation?.messages?.filter(
    (message) => message.correlation === original.correlation
  );
  const admission = messages?.length === 1 ? messages[0]?.incoming : undefined;
  const file =
    admission && !('denied' in admission)
      ? admission.files.find((file) => file.id === original.fileId)
      : undefined;
  if (!admission || 'denied' in admission || !file)
    return { ok: false, code: 2, reason: 'the original message has no matching admitted file' };
  return {
    ok: true,
    identity: {
      holder: holding,
      receiver: resolved.receiver,
      currentSessionId: resolved.currentSessionId,
      ...original
    },
    admission,
    file
  };
}

async function validateFetched(
  reply: Extract<FetchFileReply, { kind: 'fetched' }>,
  plan: Extract<FetchPlan, { ok: true }>
): Promise<void> {
  const located = await platform.privateFiles.dir();
  if (!located.supported || located.status !== 'ok')
    throw new Error(`cannot verify the managed file owner: ${located.reason}`);
  const root = located.value;
  const receiver = crypto
    .createHash('sha256')
    .update(JSON.stringify(plan.identity.receiver))
    .digest('hex');
  const key = cache.cacheId(plan.admission, plan.file, plan.identity.receiver);
  const name = path.basename(reply.path);
  const base = cache.managedBytesBase(name);
  if (
    reply.cacheKey !== plan.file.cacheKey ||
    reply.localRoot !== root ||
    path.dirname(reply.path) !== root ||
    !base ||
    !new RegExp(`^sqincoming-v1-${receiver}-${key}-[0-9a-f-]{36}$`).test(base) ||
    reply.expiresAt <= Date.now() ||
    reply.expiresAt > Date.now() + 24 * 60 * 60 * 1000
  )
    throw new Error('invalid managed file metadata');
  const before = await checkedRoot(root);
  const manifest = JSON.parse(
    (await readRegular(path.join(root, `${base}.json`), 4096)).toString('utf8')
  ) as unknown;
  if (!manifest || typeof manifest !== 'object') throw new Error('invalid managed manifest');
  const metadata = manifest as Record<string, unknown>;
  if (
    metadata.version !== 1 ||
    metadata.key !== key ||
    metadata.receiver !== receiver ||
    metadata.path !== reply.path ||
    metadata.bytes !== reply.bytes ||
    // Another authorized hit may renew the same manifest while this reply is in flight.
    typeof metadata.expiresAt !== 'number' ||
    !Number.isSafeInteger(metadata.expiresAt) ||
    metadata.expiresAt < reply.expiresAt ||
    metadata.expiresAt > Date.now() + 24 * 60 * 60 * 1000 ||
    metadata.name !== reply.name ||
    metadata.mime !== reply.mime ||
    !incoming.incomingDigest(metadata.hash)
  )
    throw new Error('managed manifest does not match the reply');
  const bytes = await readRegular(reply.path, incoming.INCOMING_FILE_MAX_BYTES);
  if (
    bytes.length !== reply.bytes ||
    crypto.createHash('sha256').update(bytes).digest('hex') !== metadata.hash
  )
    throw new Error('managed bytes do not match the reply');
  const after = await checkedRoot(root);
  if (before.identity !== after.identity || reply.expiresAt <= Date.now())
    throw new Error('managed root changed during validation');
}

async function checkedRoot(root: string): Promise<Checked> {
  const checked = await platform.privateFiles.check(root, 'managed-dir');
  if (!checked.supported || checked.status !== 'ok') throw new Error('invalid managed root');
  return checked.value;
}

async function readRegular(file: string, max: number): Promise<Buffer> {
  const read = await platform.privateFiles.read(file, 'managed-file', max);
  if (read.supported && read.status === 'ok') return read.value;
  throw new Error(read.supported ? READ_FAULTS[read.fault] : read.reason);
}

const READ_FAULTS: Record<Fault, string> = {
  refused: 'invalid managed file',
  'too-large': 'invalid managed file',
  moved: 'managed file changed before open',
  incomplete: 'incomplete managed file',
  changed: 'managed file changed while reading',
  // An attachment's descriptor faults; a managed read never answers them.
  unreadable: 'invalid managed file',
  'not-regular': 'invalid managed file',
  foreign: 'invalid managed file'
};

function die(code: number, reason: string): never {
  process.stderr.write(`squadron-fetch-file: ${reason}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const argv = await inputFile.argvOrExit('squadron-fetch-file');
  if (help.show('fetch-file', USAGE, argv)) return;
  const opts = args.parseFlags(argv, FLAGS);
  if (!opts) die(1, args.usageFor(argv, USAGE, RENAMED));
  await gate.refuseUnlessOn('fetch-file');
  const plan = await readPlan(opts);
  if (!plan.ok) die(plan.code, plan.reason);
  const file = await requests.postRequest({
    kind: 'fetchFile',
    version: 1,
    windowId: plan.identity.holder.host.windowId,
    ...plan.identity
  });
  if (!file) die(askExit({ kind: 'unwritable' }), 'could not submit the fetch request');
  const { reply, invalid } = await requests.awaitReplyDetailed(file, requests.REPLY_MS.fetchFile);
  if (invalid) die(askExit({ kind: 'unexpected' }), 'the holder returned a malformed reply');
  if (!reply)
    die(
      askExit({ kind: 'silent' }),
      `the holder did not answer request ${requests.requestIdOf(file)} within ${requests.REPLY_MS.fetchFile / 1000} s; retry`
    );
  const fetched = incoming.readFetchFileReply(reply.fetchFile);
  if (
    !fetched ||
    fetched.requestId !== requests.requestIdOf(file) ||
    JSON.stringify(fetched.identity) !==
      JSON.stringify(incoming.readFetchFileIdentity(plan.identity))
  )
    die(askExit({ kind: 'unexpected' }), 'the holder returned an unexpected or mismatched reply');
  if (fetched.kind === 'pending')
    die(askExit({ kind: 'silent' }), 'file evidence is pending; retry');
  if (fetched.kind === 'refused')
    die(askExit({ kind: fetched.code === 'timeout' ? 'silent' : 'refused' }), fetched.code);
  if (!reply.ok)
    die(askExit({ kind: 'unexpected' }), 'the holder returned an inconsistent success reply');
  try {
    await validateFetched(fetched, plan);
  } catch (error) {
    die(2, error instanceof Error ? error.message : 'invalid managed path');
  }
  process.stdout.write(`${JSON.stringify(fetched)}\n`);
}

if (require.main === module)
  void main().catch((error: unknown) => {
    die(5, error instanceof Error ? error.message : String(error));
  });
