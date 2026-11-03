import * as crypto from 'node:crypto';

export class Confirmations {
  private pending?: {
    requestId: string;
    actions: string[];
    resolve: (actionId: string | undefined) => void;
  };
  private disposed = false;

  constructor(private readonly post: (message: ConfirmModalMessage) => void) {}

  ask(view: ConfirmationView): Promise<string | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    this.cancel();
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.pending = { requestId, actions: view.actions.map((action) => action.id), resolve };
      this.post({ ...view, type: 'confirmModal', requestId });
    });
  }

  answer(requestId: string, actionId?: string): void {
    const pending = this.pending;
    if (!pending || pending.requestId !== requestId) return;
    this.pending = undefined;
    pending.resolve(
      actionId !== undefined && pending.actions.includes(actionId) ? actionId : undefined
    );
  }

  cancel(): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}
