export type Unsupported = {
  supported: false;
  reason: string;
};

export type Failed = {
  supported: true;
  status: 'failed';
  reason: string;
};

export type Success<T> = {
  supported: true;
  status: 'ok';
  value: T;
};

export type Incomplete<T> = {
  supported: true;
  status: 'incomplete';
  value: T;
  reason: string;
};

export type Result<T> = Success<T> | Incomplete<T> | Failed | Unsupported;

export function unsupported(capability: string, os: NodeJS.Platform, reason: string): Unsupported {
  return { supported: false, reason: `${capability} is unavailable on ${os}: ${reason}` };
}
