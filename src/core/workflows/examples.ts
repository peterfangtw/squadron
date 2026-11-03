import * as fs from 'fs/promises';
import * as path from 'path';
import * as files from '../files';
import * as paths from '../paths';
import * as workflows from './workflows';

const IDS = ['example-read-do-review', 'example-multiple-models'];

/** Returns output-channel lines; an already-consumed offer is silent. */
export async function seedExamples(sourceDir: string): Promise<string[]> {
  try {
    await fs.lstat(paths.WORKFLOW_EXAMPLES_MARKER);
    return [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return [`workflow examples: could not read marker: ${String(err)}`];
    }
  }

  for (const id of IDS) {
    const raw = await files.readJson<unknown>(path.join(sourceDir, `${id}.json`));
    const reasons = workflows.validate(raw);
    if (reasons.length > 0 || (raw as workflows.Workflow).id !== id) {
      return [
        `workflow examples: invalid or missing packaged ${id}: ${reasons.join('; ') || 'id does not match filename'}`
      ];
    }
  }

  try {
    await fs.mkdir(paths.WORKFLOWS_DIR, { recursive: true });
  } catch (err) {
    return [`workflow examples: could not create directory: ${String(err)}`];
  }

  try {
    // Claim before copying: another window must not restore a file deleted
    // during this offer. A crash after the claim leaves it consumed, too.
    await fs.writeFile(paths.WORKFLOW_EXAMPLES_MARKER, '', { flag: 'wx' });
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EEXIST'
      ? []
      : [`workflow examples: could not initialize: ${String(err)}`];
  }

  const lines: string[] = [];
  for (const id of IDS) {
    const file = path.join(paths.WORKFLOWS_DIR, `${id}.json`);
    try {
      await fs.copyFile(path.join(sourceDir, `${id}.json`), file, fs.constants.COPYFILE_EXCL);
      lines.push(`workflow examples: installed ${file}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        lines.push(`workflow examples: could not install ${file}: ${String(err)}`);
      }
    }
  }
  return lines;
}
