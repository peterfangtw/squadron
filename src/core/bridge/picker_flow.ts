import * as path from 'path';
import * as picker from './picker';
import * as listings from '../model_listing';
import { foldersOffered, expiredHeld } from './jobs';
import type { LaunchTarget, WindowClaim } from '../model';
import type { ActionNotice, Notice, Place, Posted, Routed } from './model';
import type { ConversationRecord, ConversationRoot, MessageRecord, NoticeRecord } from './store';
import { placeOf } from './route';
import type { Messenger } from './port';
import type { SessionVerbs, Started } from './session';
import type { MessageState } from './message_state';
import type { IncomingDelivery } from './incoming_delivery';
import * as words from './words';

/** Runs on Bridge's routing chain; the persisted draft is the only selection state. */
export class PickerFlow {
  constructor(
    private readonly options: {
      messages: MessageState;
      incoming: IncomingDelivery;
      messenger: Pick<Messenger, 'buttons'>;
      claims: () => Promise<readonly WindowClaim[]>;
      verbs: Pick<SessionVerbs, 'models'>;
      clock: () => number;
      settle: (record: ConversationRecord, word: string) => Promise<void>;
      put: (
        record: ConversationRecord,
        notice: Notice
      ) => Promise<{ ok: true; posted: Posted } | { ok: false; reason: string }>;
      putActionNotice: (
        record: ConversationRecord,
        notice: ActionNotice,
        over: Pick<NoticeRecord, 'target' | 'requestId' | 'members'>,
        place?: Place
      ) => Promise<{ ok: boolean }>;
      start: (
        record: ConversationRecord,
        message: MessageRecord | undefined,
        input: Parameters<SessionVerbs['start']>[0]
      ) => Promise<Started>;
      begun: (
        started: Extract<Started, { ok: true }>,
        windowId: string,
        cwd: string,
        label: string
      ) => ConversationRoot;
      stopped: () => boolean;
    }
  ) {}

  async recover(record: ConversationRecord): Promise<void> {
    const heldMessage = record.messages?.find(
      (message) => message.correlation === record.held?.correlation
    );
    if (heldMessage?.delivery === 'held' && !heldMessage.terminal) {
      this.options.messages.reactions.desire(heldMessage, 'queued');
      await this.options.messages.save(record);
    }
    if (record.held && !record.held.picker) {
      if (record.schema !== 3) record.schema = 2;
      record.held.picker = picker.initial(placeOf(record));
      if (await this.options.messages.save(record))
        await this.options.settle(record, words.pickerReload);
    } else if (record.held?.picker) {
      const recovered = picker.revise(record.held.picker, { kind: 'reload' });
      if (recovered !== record.held.picker && recovered.issue !== undefined) {
        record.held.picker = recovered;
        await this.options.messages.save(record);
        await this.options.put(record, words.refusalNotice(recovered.issue));
      }
    }
  }

  nextDeadline(retryMs: number): number | undefined {
    const times = this.options.messages.records.flatMap((record) =>
      record.held && record.held.picker?.stage !== 'starting' ? [record.held.expiresAt] : []
    );
    for (const record of this.options.messages.records) {
      const held = record.held;
      const draft = held?.picker;
      if (
        held &&
        draft &&
        draft.stage !== 'starting' &&
        ((draft.stage === 'model' && !draft.catalog && !draft.issue) ||
          draft.published <
            words.pickerPages(draft, held.folders, this.options.messenger.buttons.perNotice).length)
      )
        times.push(record.updatedAt + retryMs);
    }
    return times.length === 0 ? undefined : Math.min(...times);
  }

  async present(record: ConversationRecord, folder?: import('./jobs').Offered): Promise<void> {
    if (folder) await this.discover(record, folder);
    else await this.publishPicker(record);
  }

  async tick(now: number): Promise<void> {
    for (const record of this.options.messages.records) {
      const draft = record.held?.picker;
      if (!draft || draft.stage === 'starting' || (record.held?.expiresAt ?? 0) <= now) continue;
      if (draft.stage === 'model' && !draft.catalog && !draft.issue)
        await this.discover(record, draft.folder);
      else await this.publishPicker(record);
    }
    for (const record of expiredHeld(this.options.messages.records, now)) {
      await this.options.messages.finishHeld(record);
      delete record.held;
      await this.options.settle(record, words.expiredWord);
    }
  }

  async choose(routed: Extract<Routed, { kind: 'choose' }>): Promise<void> {
    const record = this.options.messages.find(routed.conversation);
    const draft = record?.held?.picker;
    if (
      !record ||
      !draft ||
      !routed.action.choice ||
      !picker.accepts(draft, routed.action.generation)
    )
      return;
    if (await this.expirePicker(record)) return;
    const selection = picker.choose(draft, routed.action);
    switch (selection.kind) {
      case 'ignore':
        return;
      case 'cancel':
        await this.options.messages.finishHeld(record);
        delete record.held;
        if (await this.options.messages.save(record))
          await this.options.settle(record, words.CANCELLED);
        return;
      case 'folder': {
        const folder = (await this.openFolders()).find((one) => one.folder === selection.value);
        if (await this.expirePicker(record)) return;
        if (folder) await this.discover(record, folder);
        else await this.resetFolders(record);
        return;
      }
      case 'discover':
        return this.discover(record, selection.folder);
      case 'advance':
        return this.advancePicker(record, selection.draft);
      case 'launch':
        return this.launch(record, selection.target, selection.source);
    }
  }

  private async openFolders(): Promise<import('./jobs').Offered[]> {
    return foldersOffered(await this.options.claims());
  }

  private async expirePicker(record: ConversationRecord): Promise<boolean> {
    if (!picker.expired(record.held, this.options.clock())) return false;
    await this.options.messages.finishHeld(record);
    delete record.held;
    if (await this.options.messages.save(record))
      await this.options.settle(record, words.expiredWord);
    return true;
  }

  private async resetFolders(record: ConversationRecord): Promise<void> {
    const held = record.held;
    const draft = held?.picker;
    if (!held || !draft) return;
    held.folders = (await this.openFolders()).map((folder) => folder.folder);
    if (await this.expirePicker(record)) return;
    if (!held.folders.length) {
      await this.options.messages.finishHeld(record);
      delete record.held;
      if (await this.options.messages.save(record)) {
        await this.options.settle(record, words.pickerEmpty);
        await this.options.put(record, { ...words.noFolderNotice, mention: record.owner });
      }
      return;
    }
    await this.advancePicker(record, picker.revise(draft, { kind: 'reset' }));
  }

  private async discover(
    record: ConversationRecord,
    folder: import('./jobs').Offered
  ): Promise<void> {
    const held = record.held;
    const before = held?.picker;
    if (!held || !before) return;
    const live = picker.folderAvailable(folder, await this.openFolders());
    if (await this.expirePicker(record)) return;
    if (!live) {
      await this.resetFolders(record);
      return;
    }
    let draft = picker.revise(before, { kind: 'discover', folder });
    held.picker = draft;
    if (!(await this.options.messages.save(record))) return;
    await this.options.settle(record, words.pickerUpdated);
    if (await this.expirePicker(record)) return;
    try {
      const catalog = this.options.verbs.models
        ? await this.options.verbs.models(folder.windowId)
        : { models: { brands: [], models: [] } };
      if (
        !listings.isModelListing(catalog.models) ||
        (catalog.remoteSelection !== undefined &&
          !listings.isLaunchTarget(catalog.remoteSelection.defaultTarget))
      )
        throw new Error(words.incompatibleModels);
      draft = picker.revise(draft, { kind: 'catalog', result: { catalog } });
    } catch (error) {
      draft = picker.revise(draft, {
        kind: 'catalog',
        result: {
          issue: words.discoveryFailed(error instanceof Error ? error.message : String(error))
        }
      });
    }
    held.picker = draft;
    const still = picker.folderAvailable(folder, await this.openFolders());
    if (await this.expirePicker(record)) return;
    if (!still) {
      await this.resetFolders(record);
      return;
    }
    await this.advancePicker(record, draft);
  }

  private async advancePicker(
    record: ConversationRecord,
    draft: picker.PickerDraft
  ): Promise<void> {
    if (!record.held) return;
    const { folder } = draft;
    if (folder) {
      const live = picker.folderAvailable(folder, await this.openFolders());
      if (await this.expirePicker(record)) return;
      if (!live) {
        await this.resetFolders(record);
        return;
      }
    }
    record.held.picker = picker.revise(draft, { kind: 'advance' });
    const message = record.messages?.find((m) => m.correlation === record.held?.correlation);
    if (message && !message.terminal && message.delivery === 'held')
      this.options.messages.reactions.desire(message, 'queued');
    if (!(await this.options.messages.save(record))) return;
    await this.options.settle(record, words.pickerUpdated);
    await this.publishPicker(record);
  }

  private async publishPicker(record: ConversationRecord): Promise<void> {
    const held = record.held;
    const draft = held?.picker;
    if (!held || !draft || draft.stage === 'starting') return;
    const pages = words.pickerPages(draft, held.folders, this.options.messenger.buttons.perNotice);
    if (draft.published >= pages.length || !(await this.options.messages.save(record))) return;
    for (let i = draft.published; i < pages.length; i++) {
      const page = pages[i];
      if (!page) continue;
      const notice: ActionNotice = {
        kind: 'picker',
        mention: record.owner,
        body:
          i === 0
            ? this.options.incoming.withIncoming(
                page.body,
                record,
                record.messages?.find((message) => message.correlation === held.correlation),
                // Not chosen yet: the session this starts is the launch default's.
                undefined
              )
            : page.body,
        buttons: page.choices.map(({ label, choice }) => ({
          label,
          action: { verb: 'choose', generation: draft.generation, choice }
        }))
      };
      const sent = await this.options.putActionNotice(
        record,
        notice,
        {},
        record.notices.some((notice) => notice.kind === 'picker') ? undefined : draft.destination
      );
      if (!sent.ok) return;
      draft.published = i + 1;
      if (!(await this.options.messages.save(record))) return;
    }
  }

  async pick(routed: Extract<Routed, { kind: 'pick' }>): Promise<void> {
    const record = this.options.messages.find(routed.conversation);
    if (!record?.held || record.held.picker) return;
    if (record.schema !== 3) record.schema = 2;
    record.held.picker = picker.initial(placeOf(record));
    if (await this.expirePicker(record)) return;
    if (routed.picked.kind === 'start') await this.discover(record, routed.picked.folder);
    else await this.resetFolders(record);
  }

  private async launch(
    record: ConversationRecord,
    target: LaunchTarget,
    source: listings.SelectionSource | undefined
  ): Promise<void> {
    const held = record.held;
    const draft = held?.picker;
    const folder = draft?.folder;
    if (!held || !draft || !folder) return;
    const live = picker.folderAvailable(folder, await this.openFolders());
    if (await this.expirePicker(record)) return;
    if (!live) {
      await this.resetFolders(record);
      return;
    }
    held.picker = picker.revise(draft, { kind: 'start', target, source });
    if (!(await this.options.messages.save(record))) return;
    await this.options.settle(record, words.pickerStarting);
    const final = picker.folderAvailable(folder, await this.openFolders());
    if (await this.expirePicker(record)) return;
    if (!final) {
      await this.resetFolders(record);
      return;
    }
    const message = record.messages?.find((m) => m.correlation === held.correlation);
    if (!(await this.options.messages.attempt(record, message))) return;
    const started = await this.options.start(record, message, {
      windowId: folder.windowId,
      cwd: folder.folder,
      prompt: held.prompt,
      ...(message ? { correlation: message.correlation } : {}),
      ...target,
      ...(source === undefined ? {} : { selection: source })
    });
    if (!started.ok) {
      const recovery = picker.startRecovery(held.picker, started);
      if (recovery.kind === 'retry') {
        if (message) {
          message.delivery = 'held';
          delete message.target;
          this.options.messages.reactions.desire(message, 'received');
          await this.options.messages.save(record);
        }
        await this.options.put(record, words.refusalNotice(recovery.reason));
        await this.discover(record, recovery.folder);
      } else {
        held.picker = recovery.draft;
        await this.options.messages.save(record);
        await this.options.put(record, words.refusalNotice(recovery.reason));
      }
      return;
    }
    if (message?.access?.attempt)
      await this.options.incoming.recover(record.id, message.correlation);
    if (
      this.options.stopped() ||
      (message?.access?.attempt && record.rootCorrelation !== message.correlation)
    )
      return;
    record.state = 'live';
    record.root = this.options.begun(
      started,
      folder.windowId,
      folder.folder,
      path.basename(folder.folder)
    );
    if (message)
      message.target = {
        pid: started.pid,
        startedAt: started.startedAt,
        windowId: folder.windowId
      };
    delete record.held;
    if (await this.options.messages.save(record)) {
      const notice = words.startedNotice(folder.folder, held.threadUnread);
      notice.body = this.options.incoming.withIncoming(
        notice.body,
        record,
        message,
        record.root?.brand
      );
      await this.options.put(record, notice);
    }
  }
}
