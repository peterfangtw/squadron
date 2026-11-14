import * as compose from '../ui/compose_doc';
import * as proseInput from './prose';
import * as formatbar from './formatbar';
import * as mentions from './mentions';
import * as kit from './kit';
import * as dom from './dom';
import * as picker from './picker';
import * as boardSettings from './board_settings';
import * as imagePolicy from '../core/image_policy';
import type * as model from '../core/model';

export type Value = {
  pool?: compose.AttachmentPool;
};
export type ChoiceContext = {
  models: readonly ModelView[];
  target?: model.LaunchTarget;
  efforts: Record<string, string>;
  allowDefault?: boolean;
  disabled?: boolean;
  cold?: string;
  onPick(target: model.LaunchTarget | undefined): void;
};
export type Options = {
  input: HTMLElement;
  formatbar: HTMLElement;
  owner(): string;
  current?(): boolean;
  imageReceiver?(): string;
  value(): Value;
  sources(): mentions.MentionSources;
  changed(): void;
  opened(): void;
  locked(): boolean;
  canAttach(): boolean;
  attach(image: ComposerImage): string | undefined;
  error(reason: string): void;
  sessionName?(pid: number): string | undefined;
  onKey?(event: KeyboardEvent): boolean;
};
export type ComposeInput = {
  editor: proseInput.Prose;
  snapshot(): {
    doc: compose.ComposeDoc;
    delivered: string;
    attachments: compose.AttachmentPool;
    images: ComposerImage[];
  };
  dispose(): void;
};

export function mount(options: Options): ComposeInput {
  let disposed = false;
  const editor = proseInput.createProse(options.input, {
    mode: 'rich',
    label: 'Task',
    onChange: () => options.changed(),
    onKey: (event) => options.onKey?.(event) ?? false,
    sessionName: (pid) => options.sessionName?.(pid)
  });
  const toolbar = formatbar.attachFormatbar(options.formatbar, editor);
  editor.update({ onFormat: (formats) => toolbar.paint(formats) });
  const detach = mentions.attachMentions(editor.selection, {
    opened: () => options.opened(),
    sources: () => options.sources(),
    skillsChanged: (skills) => editor.update({ skills }),
    write: (mention) => {
      if (options.locked()) return '';
      editor.insertChip(mention.kind, mention.expansion);
      return `${mention.expansion} `;
    }
  });
  const paste = (event: ClipboardEvent): void => {
    if (options.locked() || !options.canAttach()) return;
    const images = [...(event.clipboardData?.files ?? [])].filter((file) =>
      file.type.startsWith('image/')
    );
    if (!images.length) return;
    event.preventDefault();
    const owner = options.owner();
    const current = (): boolean =>
      !disposed && options.owner() === owner && (options.current?.() ?? true);
    for (const file of images) {
      if (!imagePolicy.FORMATS.some(([mediaType]) => mediaType === file.type)) {
        options.error(
          `${options.imageReceiver?.() ?? 'Sessions take'} PNG, JPEG, GIF and WebP images — not ${file.type}.`
        );
        continue;
      }
      if (file.size > imagePolicy.MAX_BYTES) {
        options.error(`That image is ${Math.round(file.size / 1e6)}MB; the limit here is 10MB.`);
        continue;
      }
      // FileReader supplies the data URL directly and is implemented by jsdom.
      const reader = new FileReader();
      reader.onload = () => {
        // Decode is asynchronous; only the same owner in the same shown box receives it.
        if (!current()) return;
        if (typeof reader.result !== 'string') {
          options.error('That image could not be read.');
          return;
        }
        const id = options.attach({
          name: file.name || 'pasted image',
          mediaType: file.type,
          dataUrl: reader.result
        });
        if (id) editor.insertChip('image', '[Image #1]', id);
      };
      reader.onerror = () => {
        if (current()) options.error('That image could not be read.');
      };
      reader.readAsDataURL(file);
    }
  };
  // ProseMirror skips a paste already prevented during the capture phase.
  options.input.addEventListener('paste', paste, true);
  return {
    editor,
    snapshot: () => {
      const doc = editor.snapshot() as compose.ComposeDoc;
      const value = options.value();
      const captured = compose.capture(doc, value.pool ?? {});
      return {
        doc,
        delivered: proseInput.deliveryOf(captured.wire).trimEnd(),
        attachments: captured.attachments,
        images: captured.images
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      detach();
      options.input.removeEventListener('paste', paste, true);
      editor.destroy();
    }
  };
}

const filePicks = new Map<string, { owner: string; receive: (paths: string[]) => void }>();

export function registerFilePick(
  operationId: string,
  owner: string,
  receive: (paths: string[]) => void
): void {
  filePicks.set(operationId, { owner, receive });
}

export function discardFilePicks(owner: string): void {
  for (const [id, pending] of filePicks) if (pending.owner === owner) filePicks.delete(id);
}

export function takeFiles(message: PickedFilesMessage): boolean {
  const pending = filePicks.get(message.operationId);
  if (!pending) return false;
  filePicks.delete(message.operationId);
  pending.receive(message.paths);
  return true;
}

export function appendFiles(
  doc: compose.ComposeDoc | undefined,
  paths: readonly string[]
): compose.ComposeDoc {
  const existing = new Set<string>();
  const visit = (node: compose.ComposeNode): void => {
    if (
      node.type === 'chip' &&
      node.attrs?.kind === 'file' &&
      typeof node.attrs.expansion === 'string'
    )
      existing.add(node.attrs.expansion);
    node.content?.forEach(visit);
  };
  if (doc) visit(doc);
  const content = [...new Set(paths)]
    .filter((file) => !existing.has(file))
    .flatMap((file) => [
      { type: 'chip', attrs: { kind: 'file', expansion: file, attachmentId: null } },
      { type: 'text', text: ' ' }
    ]);
  return (
    compose.appendBlocks(doc, { type: 'doc', content: [{ type: 'paragraph', content }] }) ?? {
      type: 'doc',
      content: []
    }
  );
}

export function workflowSlot(
  root: HTMLElement,
  workflows: readonly WorkflowView[],
  selected: string | undefined,
  pick: (id: string | undefined) => void
): void {
  if (kit.heldOpen(root)) return;
  kit.paintIfChanged(root, JSON.stringify([workflows, selected]), () => {
    const chosen = workflows.find((workflow) => workflow.id === selected);
    if (selected !== undefined) {
      const chip = dom.el('div', 'wflow armed');
      const drop = dom.el('button', 'drop', '×');
      drop.setAttribute('aria-label', 'Remove this workflow');
      drop.onclick = () => pick(undefined);
      chip.append(dom.el('span', 'nm', chosen?.label ?? `Unavailable workflow: ${selected}`), drop);
      root.replaceChildren(chip);
    } else
      root.replaceChildren(
        picker.picker({
          label: 'Apply workflow…',
          options: workflows.map((workflow) => ({
            id: workflow.id,
            label: workflow.label,
            sub: `${workflow.steps.length} steps`
          })),
          value: [],
          onChange: ({ value }) => pick(value[0])
        })
      );
  });
}

export function choiceControls(
  root: HTMLElement,
  context: () => ChoiceContext
): { render(): void; dispose(): void } {
  const model = kit.dropdownTrigger('', 'model');
  const effort = kit.dropdownTrigger('', 'effort');
  model.wrap.append(
    kit.opensMenu(model.wrap, model.button, 'start', (menu) =>
      boardSettings.modelChoices(menu, context())
    )
  );
  effort.wrap.append(
    kit.opensMenu(effort.wrap, effort.button, 'start', (menu) =>
      boardSettings.effortChoices(menu, context())
    )
  );
  root.append(model.wrap, effort.wrap);
  return {
    render: () => {
      if (kit.heldOpen(model.wrap) || kit.heldOpen(effort.wrap)) return;
      const ctx = context();
      const selected = ctx.models.find(
        (row) => row.value === ctx.target?.model && row.window === ctx.target?.window
      );
      model.label.textContent = selected?.name ?? ctx.target?.model ?? 'Current default';
      model.button.disabled = ctx.disabled ?? false;
      effort.label.textContent = ctx.target?.effort ?? selected?.defaultEffort ?? 'effort';
      effort.wrap.hidden = !selected?.efforts?.length;
    },
    dispose: () => {
      if (kit.heldOpen(model.wrap) || kit.heldOpen(effort.wrap)) kit.closeMenu();
      model.wrap.remove();
      effort.wrap.remove();
    }
  };
}
