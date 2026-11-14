import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as files from '../files';
import * as git from '../git';
import * as paths from '../paths';
import * as platform from '../platform';
import * as claim from '../coordination/owner_claim';
import * as incoming from '../incoming';
import * as brands from '../brands';
import * as modelListing from '../model_listing';
import * as compose from '../../ui/compose_doc';
import * as imagePolicy from '../image_policy';
import * as schedule from './schedule';
import type * as types from './types';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MEDIA = new Set<string>(imagePolicy.FORMATS.map(([media]) => media));
let cache: { file: string; stamp: string; record: types.Repository } | undefined;

export async function resolveScope(launchCwd: string): Promise<types.Scope> {
  const checkout = await git.readCheckout(launchCwd);
  const root = await fs.realpath(checkout?.repoRoot ?? launchCwd);
  const repoRoot = platform.paths.key(root);
  return {
    repoRoot,
    repoKey: crypto.createHash('sha256').update(repoRoot).digest('hex'),
    launchCwd
  };
}

export function directory(scope: Pick<types.Scope, 'repoKey'>): string {
  if (!HASH.test(scope.repoKey)) throw new Error('Invalid repository identity.');
  return path.join(paths.ROUTINES_DIR, scope.repoKey);
}

export function stateFile(scope: Pick<types.Scope, 'repoKey'>): string {
  return path.join(directory(scope), 'state.json');
}

export async function read(scope: types.Scope): Promise<types.Repository> {
  if (crypto.createHash('sha256').update(scope.repoRoot).digest('hex') !== scope.repoKey)
    throw new Error('Repository identity does not match its root.');
  const file = stateFile(scope);
  const stamp = await files.fileStamp(file);
  const cached = cache?.file === file ? cache : undefined;
  if (cached?.stamp === stamp) return structuredClone(cached.record);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      schema: 1,
      repoRoot: scope.repoRoot,
      repoKey: scope.repoKey,
      revision: 0,
      routines: {},
      attempts: {}
    };
  }
  if (!validRepository(raw, scope))
    throw new Error(`Unsupported or corrupt routine state: ${file}`);
  cache = { file, stamp, record: raw };
  return structuredClone(raw);
}

export async function mutate(
  scope: types.Scope,
  change: (record: types.Repository) => Promise<types.Result> | types.Result
): Promise<types.Result> {
  let release: (() => Promise<void>) | undefined;
  try {
    const dir = directory(scope);
    await fs.mkdir(dir, { recursive: true });
    const table = await claim.native();
    const startedAt = table.starts.get(process.pid);
    if (startedAt === undefined) throw new Error('Routine writer identity is unavailable.');
    release = await claim.acquire(
      path.join(dir, 'mutation.lock'),
      {
        pid: process.pid,
        startedAt,
        startSource: table.startSource,
        generation: crypto.randomUUID()
      },
      'Another window is saving routines.',
      table
    );
    const record = await read(scope);
    const result = await change(record);
    if (result.kind !== 'ok') return result;
    record.revision++;
    if (!(await files.writeAtomicJson(stateFile(scope), record)))
      return {
        kind: 'io',
        reason: 'Could not save routines. Your changes have not been acknowledged.'
      };
    cache = undefined;
    return result;
  } catch (error) {
    return { kind: 'io', reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await release?.();
  }
}

export async function saveTask(scope: types.Scope, input: types.TaskInput): Promise<types.Task> {
  if (!validTaskInput(input)) throw new Error('The saved task is invalid or too large.');
  const images: types.Task['images'] = {};
  let bytes = 0;
  for (const id of compose.attachmentIds(input.doc)) {
    const entry = input.attachments[id];
    if (!entry) throw new Error('An image is missing. Paste it again before saving.');
    const { mediaType, name, dataUrl } = entry.image;
    const prefix = `data:${mediaType};base64,`;
    const body = dataUrl.slice(prefix.length);
    if (
      !MEDIA.has(mediaType) ||
      !dataUrl.startsWith(prefix) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)
    )
      throw new Error('An image has unsupported or invalid bytes. Paste it again.');
    const data = Buffer.from(body, 'base64');
    bytes += data.length;
    if (!data.length || bytes > imagePolicy.MAX_BYTES)
      throw new Error('Task images must total at most 10 MiB.');
    const blobHash = crypto.createHash('sha256').update(data).digest('hex');
    // Content-addressed bytes are verified again before every launch.
    await publishBlob(path.join(directory(scope), 'images', blobHash), blobHash, data);
    images[id] = { blobHash, name, mediaType };
  }
  const { attachments: _attachments, ...task } = input;
  return { ...task, images };
}

/**
 * Verified bytes published whole under their hash. A damaged copy (a write cut
 * short) is replaced by the same rename, so saving the image again repairs it.
 */
async function publishBlob(file: string, hash: string, data: Buffer): Promise<void> {
  try {
    if (
      crypto
        .createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex') === hash
    )
      return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, data, { flag: 'wx' });
    await platform.files.replace(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function restoreTask(
  scope: types.Scope,
  task: types.Task,
  checkFiles = false,
  allowMissingImages = false
): Promise<types.TaskInput> {
  const attachments: Record<string, compose.Attachment> = {};
  let bytes = 0;
  for (const id of compose.attachmentIds(task.doc)) {
    const image = task.images[id];
    if ((!image || !HASH.test(image.blobHash)) && !allowMissingImages)
      throw new Error('A saved image is missing. Paste it again.');
    if (!image || !HASH.test(image.blobHash)) continue;
    let data: Buffer;
    try {
      data = await fs.readFile(path.join(directory(scope), 'images', image.blobHash));
    } catch (error) {
      if (allowMissingImages) continue;
      throw error;
    }
    bytes += data.length;
    if (
      bytes > imagePolicy.MAX_BYTES ||
      crypto.createHash('sha256').update(data).digest('hex') !== image.blobHash
    ) {
      if (allowMissingImages) continue;
      throw new Error('A saved image is damaged or too large. Paste it again.');
    }
    attachments[id] = {
      kind: 'image',
      image: {
        name: image.name,
        mediaType: image.mediaType,
        dataUrl: `data:${image.mediaType};base64,${data.toString('base64')}`
      }
    };
  }
  if (checkFiles) {
    const visit = async (node: compose.ComposeNode): Promise<void> => {
      if (node.type === 'chip' && node.attrs?.kind === 'file') {
        const file = node.attrs.expansion;
        if (typeof file !== 'string' || !path.isAbsolute(file))
          throw new Error('A saved file path is invalid.');
        try {
          await fs.access(file);
        } catch {
          throw new Error(
            `The saved file is unavailable: ${file}. Update the task before running.`
          );
        }
      }
      for (const child of node.content ?? []) await visit(child);
    };
    await visit(task.doc);
  }
  const { images: _images, ...value } = task;
  return { ...value, attachments };
}

function record(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw);
}

function validDoc(raw: unknown, depth = 0): boolean {
  if (depth > 30 || !record(raw) || typeof raw.type !== 'string') return false;
  if (raw.text !== undefined && typeof raw.text !== 'string') return false;
  if (raw.attrs !== undefined && !record(raw.attrs)) return false;
  if (raw.type === 'chip') {
    if (
      !record(raw.attrs) ||
      typeof raw.attrs.kind !== 'string' ||
      typeof raw.attrs.expansion !== 'string'
    )
      return false;
    if (
      raw.attrs.kind === 'image' &&
      (typeof raw.attrs.attachmentId !== 'string' || !raw.attrs.attachmentId)
    )
      return false;
  }
  if (
    raw.marks !== undefined &&
    (!Array.isArray(raw.marks) ||
      !raw.marks.every((mark) => record(mark) && typeof mark.type === 'string'))
  )
    return false;
  return (
    raw.content === undefined ||
    (Array.isArray(raw.content) && raw.content.every((node) => validDoc(node, depth + 1)))
  );
}

function validTarget(raw: unknown): boolean {
  if (!record(raw)) return false;
  if (raw.kind === 'default') return true;
  if (raw.kind !== 'explicit' || !record(raw.target)) return false;
  return (
    brands.isBrand(raw.target.brand) &&
    typeof raw.target.model === 'string' &&
    raw.target.model.length > 0 &&
    (raw.target.window === undefined ||
      (Number.isSafeInteger(raw.target.window) && Number(raw.target.window) > 0)) &&
    (raw.target.effort === undefined || typeof raw.target.effort === 'string')
  );
}

export function validTaskInput(raw: unknown): raw is types.TaskInput {
  if (
    !record(raw) ||
    !record(raw.doc) ||
    raw.doc.type !== 'doc' ||
    !Array.isArray(raw.doc.content) ||
    !validDoc(raw.doc) ||
    JSON.stringify(raw.doc).length > 1_000_000
  )
    return false;
  return (
    typeof raw.delivered === 'string' &&
    raw.delivered.length <= 1_000_000 &&
    (raw.delivered.trim().length > 0 ||
      (typeof raw.workflowId === 'string' && raw.workflowId.length > 0)) &&
    (raw.workflowId === undefined ||
      (typeof raw.workflowId === 'string' && raw.workflowId.length > 0)) &&
    validTarget(raw.targetChoice) &&
    typeof raw.savedFromCwd === 'string' &&
    path.isAbsolute(raw.savedFromCwd) &&
    record(raw.attachments)
  );
}

function validTask(raw: unknown): raw is types.Task {
  return (
    record(raw) &&
    validTaskInput({ ...raw, attachments: {} }) &&
    record(raw.images) &&
    Object.values(raw.images).every(
      (image) =>
        record(image) &&
        typeof image.blobHash === 'string' &&
        HASH.test(image.blobHash) &&
        typeof image.name === 'string' &&
        MEDIA.has(String(image.mediaType))
    )
  );
}

export function validMember(raw: unknown): raw is types.Member {
  return claim.isKnown(raw) && raw.startedAt > 0 && raw.startSource !== undefined;
}

function validRepository(raw: unknown, scope: types.Scope): raw is types.Repository {
  if (
    !record(raw) ||
    raw.schema !== 1 ||
    raw.repoKey !== scope.repoKey ||
    raw.repoRoot !== scope.repoRoot ||
    !Number.isSafeInteger(raw.revision) ||
    Number(raw.revision) < 0 ||
    !record(raw.routines) ||
    !record(raw.attempts)
  )
    return false;
  for (const [id, item] of Object.entries(raw.routines)) {
    if (
      !UUID.test(id) ||
      !record(item) ||
      item.id !== id ||
      !Number.isSafeInteger(item.definitionRevision) ||
      Number(item.definitionRevision) < 1 ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      item.name.length > 120 ||
      typeof item.enabled !== 'boolean' ||
      !Number.isFinite(item.createdAt) ||
      !Number.isFinite(item.updatedAt) ||
      !validTask(item.task) ||
      !schedule.validSchedule(item.schedule) ||
      typeof item.scheduleEpoch !== 'string' ||
      !UUID.test(item.scheduleEpoch) ||
      !Array.isArray(item.handled) ||
      !item.handled.every(
        (value) =>
          record(value) &&
          typeof value.key === 'string' &&
          ['completed', 'skipped'].includes(String(value.outcome)) &&
          Number.isFinite(value.at)
      )
    )
      return false;
    if (
      (item.anchorAt !== undefined && !Number.isFinite(item.anchorAt)) ||
      (item.activeRunId !== undefined &&
        (typeof item.activeRunId !== 'string' || !UUID.test(item.activeRunId)))
    )
      return false;
  }
  for (const [id, item] of Object.entries(raw.attempts)) {
    if (
      !UUID.test(id) ||
      !record(item) ||
      item.runId !== id ||
      typeof item.routineId !== 'string' ||
      !raw.routines[item.routineId] ||
      !Number.isFinite(item.requestedAt) ||
      typeof item.cwd !== 'string' ||
      typeof item.nativeCwd !== 'string' ||
      !path.isAbsolute(item.nativeCwd) ||
      !Number.isSafeInteger(item.definitionRevision) ||
      Number(item.definitionRevision) < 1 ||
      typeof item.scheduleEpoch !== 'string' ||
      !UUID.test(item.scheduleEpoch) ||
      typeof item.occurrenceKey !== 'string' ||
      !modelListing.isLaunchTarget(item.target) ||
      !validTask(item.task) ||
      !incoming.readHostIdentity(item.owner) ||
      ![
        'reserved',
        'spawning',
        'child',
        'bound',
        'admitted',
        'started',
        'stopped',
        'done'
      ].includes(String(item.phase)) ||
      !Array.isArray(item.members) ||
      !item.members.every(validMember)
    )
      return false;
    if (item.child !== undefined && !validMember(item.child)) return false;
    if (item.cleanupUnprovable !== undefined && typeof item.cleanupUnprovable !== 'boolean')
      return false;
    if (item.receiver !== undefined && !incoming.readReceiverIdentity(item.receiver)) return false;
    if (item.observation !== undefined) {
      const observation = item.observation;
      if (
        !record(observation) ||
        !validMember(observation.writer) ||
        !Number.isSafeInteger(observation.generation) ||
        typeof observation.tenure !== 'string' ||
        !UUID.test(observation.tenure) ||
        typeof observation.pending !== 'boolean' ||
        typeof observation.absent !== 'boolean' ||
        !['observed', 'limited'].includes(String(observation.coverage))
      )
        return false;
    }
  }
  return true;
}
