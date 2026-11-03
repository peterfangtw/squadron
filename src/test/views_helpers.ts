import { Session } from '../core/model';

export const session = (over: Partial<Session>): Session => ({
  pid: 100,
  sessionId: 'sid',
  cwd: '/work/app',
  name: '',
  status: 'idle',
  hasCommand: false,
  startedAt: 0,
  updatedAt: 0,
  transcript: '',
  ...over
});
