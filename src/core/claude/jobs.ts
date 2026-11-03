import * as fs from 'fs/promises';
import * as path from 'path';
import { CLAUDE_DIR } from '../paths';

type JobState = {
  /** The pending request, when blocked — e.g. "approve Bash: git log …". */
  needs?: string;
  /** The job lifecycle state — `done`/`failed` are terminal. */
  state?: string;
};

/**
 * Background sessions keep a job record the CLI writes alongside them. It says
 * what the session is blocked on and its lifecycle state — the only handle we
 * have on one: they own no terminal we can show.
 */
export async function readJob(jobId: string): Promise<JobState | undefined> {
  try {
    const raw = await fs.readFile(path.join(CLAUDE_DIR, 'jobs', jobId, 'state.json'), 'utf8');
    const state = JSON.parse(raw);
    return {
      needs: typeof state.needs === 'string' ? state.needs : undefined,
      state: typeof state.state === 'string' ? state.state : undefined
    };
  } catch {
    return undefined;
  }
}
