import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as util from 'node:util';
import * as validation from '../../cli/workflow-validation';
import * as paths from '../../core/paths';
import { homeEnv, repoRoot, withoutForceColor } from '../helpers';

const bundle = path.join(repoRoot(), 'dist', `${paths.WORKFLOW_VALIDATION_SHIM}.js`);
const execFile = util.promisify(childProcess.execFile);
const definition = {
  id: 'review',
  label: 'Review',
  steps: [{ id: 'read', label: 'Read task', prompt: 'Read the task in ${cwd}.' }]
};
let root: string;
let home: string;
let file: string;

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-validation-')));
});
after(() => fs.rm(root, { recursive: true, force: true }));
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(root, 'home-'));
  file = path.join(home, 'candidate.json');
  await fs.writeFile(file, JSON.stringify(definition));
});

describe('workflow-validation', () => {
  it('documents its installed command and flags in the builder skill', async () => {
    const text = await fs.readFile(
      path.join(repoRoot(), 'install', 'skills', 'squadron-workflow-builder', 'FORMAT.md'),
      'utf8'
    );
    assert.ok(text.includes(`~/.squadron/bin/${paths.WORKFLOW_VALIDATION_SHIM}`));
    for (const flag of validation.FLAGS) assert.ok(text.includes(`--${flag}`));
  });

  it('runs the bundled command without an IDE or a session and writes no run state', async () => {
    const { stdout, stderr } = await execFile(process.execPath, [bundle, '--file-path', file], {
      cwd: home,
      env: withoutForceColor({ ...process.env, ...homeEnv(home) })
    });
    assert.deepEqual(JSON.parse(stdout), { ok: true, file, cwd: home, reasons: [] });
    assert.equal(stderr, '');
    await assert.rejects(fs.stat(path.join(home, '.squadron')), { code: 'ENOENT' });
  });

  it('returns machine-readable errors and exit 2 for an invalid workflow', async () => {
    await fs.writeFile(file, JSON.stringify({ ...definition, steps: [] }));
    await assert.rejects(
      execFile(process.execPath, [bundle, '--file-path', file, '--cwd-path', home], {
        env: withoutForceColor()
      }),
      (error: unknown) => {
        const result = error as { code: number; stdout: string; stderr: string };
        assert.equal(result.code, 2);
        assert.deepEqual(JSON.parse(result.stdout), {
          ok: false,
          file,
          cwd: home,
          reasons: ['needs at least one step']
        });
        assert.equal(result.stderr, '');
        return true;
      }
    );
  });

  it('normalizes old chains just as the workflow reader does', async () => {
    await fs.writeFile(
      file,
      JSON.stringify({
        ...definition,
        steps: [...definition.steps, { id: 'finish', label: 'Finish', prompt: 'Report findings.' }]
      })
    );
    assert.equal((await validation.validateFile(file, home)).ok, true);
  });

  it('reports optional field type errors together', async () => {
    await fs.writeFile(
      file,
      JSON.stringify({
        ...definition,
        description: 7,
        steps: [
          {
            ...definition.steps[0],
            output: [],
            advance: 'always',
            onFail: true,
            retries: 'twice',
            check: { command: 'true', cwd: 1, timeoutMs: 'soon' }
          }
        ]
      })
    );
    assert.deepEqual((await validation.validateFile(file, home)).reasons, [
      'needs its description to be text',
      'read needs its check cwd to be text',
      'read needs its check timeoutMs to be a finite number',
      'read needs its output to be text',
      'read needs its advance to be manual or auto',
      'read needs its onFail to be retry, ask or abort',
      'read needs its retries to be a finite number'
    ]);
  });

  it('refuses an unwired lane and a forward dependency', async () => {
    await fs.writeFile(
      file,
      JSON.stringify({
        ...definition,
        steps: [
          ...definition.steps,
          { id: 'peer', label: 'Peer', prompt: 'Review independently.', lane: 'Reviewer' }
        ]
      })
    );
    assert.match(
      (await validation.validateFile(file, home)).reasons.join('\n'),
      /no step wired before/
    );
    await fs.writeFile(
      file,
      JSON.stringify({
        ...definition,
        steps: [
          { ...definition.steps[0], needs: ['later'] },
          { id: 'later', label: 'Later', prompt: 'Report.', needs: ['read'] }
        ]
      })
    );
    assert.match(
      (await validation.validateFile(file, home)).reasons.join('\n'),
      /not an earlier step/
    );
  });

  it('resolves project skills in the target directory and reports missing commands', async () => {
    const project = path.join(home, 'project');
    const skill = path.join(project, '.claude', 'skills', 'local-review');
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, 'SKILL.md'), 'Project review skill.');
    await fs.writeFile(
      file,
      JSON.stringify({
        ...definition,
        steps: [{ id: 'read', label: 'Read', uses: '/local-review' }]
      })
    );
    const { stdout } = await execFile(
      process.execPath,
      [bundle, '--file-path', file, '--cwd-path', project, '--brand', 'claude'],
      {
        cwd: home,
        env: { ...process.env, ...homeEnv(home) }
      }
    );
    assert.equal((JSON.parse(stdout) as { ok: boolean }).ok, true);
    assert.equal((await validation.validateFile(file, home, 'claude')).ok, false);
  });

  it('checks uses in the folders of the brand passed, and refuses an unknown brand', async () => {
    const project = path.join(home, 'project');
    const skill = path.join(project, '.claude', 'skills', 'local-review');
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, 'SKILL.md'), 'Project review skill.');
    await fs.writeFile(
      file,
      JSON.stringify({
        ...definition,
        steps: [{ id: 'read', label: 'Read', uses: '/local-review' }]
      })
    );
    const run = (brand: string) =>
      execFile(
        process.execPath,
        [bundle, '--file-path', file, '--cwd-path', project, '--brand', brand],
        {
          cwd: home,
          env: { ...process.env, ...homeEnv(home) }
        }
      );
    assert.equal((JSON.parse((await run('grok')).stdout) as { ok: boolean }).ok, true);
    await assert.rejects(run('codex'), (error: unknown) => {
      const result = error as { code: number; stdout: string };
      assert.equal(result.code, 2);
      assert.deepEqual((JSON.parse(result.stdout) as { reasons: string[] }).reasons, [
        `read uses /local-review, which does not exist in ${project}`
      ]);
      return true;
    });
    await assert.rejects(run('gemini'), (error: unknown) => {
      assert.equal((error as { code: number }).code, 1);
      return true;
    });
  });

  it('asks for the starting brand instead of checking a uses that runs there as Claude', async () => {
    const project = path.join(home, 'project');
    await fs.mkdir(path.join(project, '.claude', 'skills', 'local-review'), { recursive: true });
    await fs.writeFile(
      path.join(project, '.claude', 'skills', 'local-review', 'SKILL.md'),
      'Project review skill.'
    );
    await fs.writeFile(
      file,
      JSON.stringify({
        ...definition,
        steps: [
          { id: 'read', label: 'Read', uses: '/local-review' },
          {
            id: 'peer',
            label: 'Peer',
            lane: 'p',
            brand: 'grok',
            needs: ['read'],
            uses: '/local-review'
          }
        ]
      })
    );
    assert.deepEqual((await validation.validateFile(file, project)).reasons, [
      'read uses /local-review in the session the workflow starts in; pass --brand claude|grok|codex to say which CLI that is'
    ]);
    // A file whose every uses states its lane's brand needs no --brand.
    await fs.writeFile(
      file,
      JSON.stringify({
        ...definition,
        steps: [
          ...definition.steps,
          {
            id: 'peer',
            label: 'Peer',
            lane: 'p',
            brand: 'grok',
            needs: ['read'],
            uses: '/local-review'
          }
        ]
      })
    );
    assert.deepEqual((await validation.validateFile(file, project)).reasons, []);
  });

  it('reports bad JSON, missing files, and a non-directory target', async () => {
    await fs.writeFile(file, '{');
    assert.equal((await validation.validateFile(file, home)).ok, false);
    assert.match(
      (await validation.validateFile(path.join(home, 'missing.json'), home)).reasons.join('\n'),
      /ENOENT/
    );
    await fs.writeFile(file, JSON.stringify(definition));
    assert.deepEqual((await validation.validateFile(file, file)).reasons, [
      `not a directory: ${file}`
    ]);
  });

  it('returns usage exit 1 for missing or unknown arguments', async () => {
    for (const argv of [[], ['--file-path'], ['--file-path', file, '--unknown', 'value']]) {
      await assert.rejects(execFile(process.execPath, [bundle, ...argv]), (error: unknown) => {
        const result = error as { code: number; stderr: string };
        assert.equal(result.code, 1);
        assert.match(result.stderr, /usage: workflow-validation/);
        return true;
      });
    }
  });
});
