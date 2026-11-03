import * as help from './help';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as args from './args';
import { DEFAULT_BRAND } from '../core/brands';
import type { BrandId } from '../core/model';
import * as workflows from '../core/workflows/workflows';
import * as inputFile from './input_file';

const USAGE = `usage: workflow-validation --file-path <workflow.json> [--cwd-path <directory>] [--brand ${args.BRAND_CHOICES}]`;
export const FLAGS = ['file-path', 'cwd-path', 'brand'] as const;

/** `--file-path`, as `squadron-attach` takes a path. */
const RENAMED: args.Renamed<typeof FLAGS> = { file: 'file-path', cwd: 'cwd-path' };

/**
 * `brand` is the brand of the session the workflow will be armed at; lanes
 * that state none inherit it. A file names no such session, so without one a
 * `uses` that runs there is reported rather than checked as some brand's.
 */
export async function validateFile(
  file: string,
  cwd: string,
  brand?: BrandId
): Promise<{ ok: boolean; file: string; cwd: string; reasons: string[] }> {
  const absoluteFile = path.resolve(file);
  const absoluteCwd = path.resolve(cwd);
  const reasons: string[] = [];
  try {
    const raw: unknown = JSON.parse(await fs.readFile(absoluteFile, 'utf8'));
    const definition = workflows.normaliseDefinition(raw);
    reasons.push(...workflows.validate(definition));
    if (!(await fs.stat(absoluteCwd)).isDirectory()) {
      reasons.push(`not a directory: ${absoluteCwd}`);
    }
    if (reasons.length === 0) {
      const workflow = definition as workflows.Workflow;
      const unnamed = brand === undefined ? unbranded(workflow) : [];
      reasons.push(
        ...(unnamed.length > 0
          ? unnamed
          : await workflows.armable(workflow, absoluteCwd, brand ?? DEFAULT_BRAND))
      );
    }
  } catch (error: unknown) {
    reasons.push(error instanceof Error ? error.message : String(error));
  }
  return { ok: reasons.length === 0, file: absoluteFile, cwd: absoluteCwd, reasons };
}

/** The `uses` steps whose brand is the starting session's, which a file does
 *  not name. With none, no step's check depends on the anchor's brand, so
 *  `DEFAULT_BRAND` above stands for nothing. */
function unbranded(workflow: workflows.Workflow): string[] {
  return workflow.steps
    .filter((step) => step.uses !== undefined && !workflows.statedBrand(workflow.steps, step))
    .map(
      (step) =>
        `${step.id} uses ${step.uses ?? ''} in the session the workflow starts in; pass --brand ${args.BRAND_CHOICES} to say which CLI that is`
    );
}

async function main(): Promise<void> {
  const argv = await inputFile.argvOrExit('workflow-validation');
  if (help.show('workflow-validation', USAGE, argv)) return;
  const options = args.parseFlags(argv, FLAGS);
  const brand = args.asBrand(options?.brand);
  if (
    !options?.['file-path'] ||
    options['cwd-path'] === '' ||
    (options.brand !== undefined && !brand)
  ) {
    process.stderr.write(`${args.usageFor(argv, USAGE, RENAMED)}\n`);
    process.exitCode = 1;
    return;
  }
  const result = await validateFile(
    options['file-path'],
    options['cwd-path'] ?? process.cwd(),
    brand
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 2;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `workflow-validation: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 5;
  });
}
