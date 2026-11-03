import * as sheet from './sheet';

let cancelPrevious: (() => void) | undefined;

export function confirmModal(
  view: ConfirmationView,
  respond: (actionId: string | undefined) => void
): void {
  cancelPrevious?.();
  let settled = false;
  const modal = sheet.openSheet({
    id: 'cscrim',
    position: 'panel',
    title: view.title,
    modal: true,
    onClose: () => finish()
  });
  cancelPrevious = () => finish();
  modal.body.id = 'confirm-detail';
  modal.body.textContent = view.detail;
  modal.element.setAttribute('aria-describedby', modal.body.id);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'b sec';
  cancel.textContent = 'Cancel';
  cancel.autofocus = true;
  cancel.onclick = () => finish();
  modal.foot.append(cancel);
  for (const action of view.actions) {
    const button = document.createElement('button');
    button.className = action.destructive ? 'b dgr' : 'b pri';
    button.textContent = action.label;
    button.type = 'button';
    button.onclick = () => finish(action.id);
    modal.foot.append(button);
  }
  cancel.focus({ preventScroll: true });

  function finish(actionId?: string): void {
    if (settled) return;
    settled = true;
    cancelPrevious = undefined;
    modal.close();
    respond(actionId);
  }
}
