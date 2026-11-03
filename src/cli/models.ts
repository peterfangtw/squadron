import * as help from './help';
import * as args from './args';
import * as windows from './windows';
import * as claims from '../core/coordination/claims';
import * as ask from '../core/coordination/ask';
import * as published from '../core/published';
import { isModelListing } from '../core/model_listing';
import * as inputFile from './input_file';

const USAGE = `usage: squadron-models [--brand ${args.BRAND_CHOICES}]`;
export const FLAGS = ['brand'] as const;

export function parseArgs(argv: readonly string[]): { brand?: string } | undefined {
  const options = args.parseFlags(argv, FLAGS);
  if (!options || (options.brand !== undefined && !args.asBrand(options.brand))) return undefined;
  return options;
}

function die(code: number, message: string): never {
  process.stderr.write(`squadron-models: ${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const argv = await inputFile.argvOrExit('squadron-models');
  if (help.show('models', USAGE, argv)) return;
  const options = parseArgs(argv);
  if (!options) die(1, USAGE);
  const live = await claims.readClaims();
  if (!live.length) die(3, 'no IDE window is running with Squadron installed');
  const window = await windows.pickWindow(
    live,
    process.cwd(),
    windows.originWindow(process.env, await published.readPublished())
  );
  if (!window) die(3, 'no IDE window is running with Squadron installed');
  const result = await ask.ask({ kind: 'models', windowId: window.id }, 20_000);
  if (!result.ok) {
    die(ask.askExit(result), result.reason);
  }
  const listing = result.reply.models;
  if (!isModelListing(listing)) {
    die(
      ask.askExit({ kind: 'unexpected' }),
      'the window returned an incompatible model listing; update Squadron and reload that window'
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      window: { id: window.id, label: window.label },
      brands: listing.brands.filter((row) => !options.brand || row.brand === options.brand),
      models: listing.models.filter((row) => !options.brand || row.brand === options.brand)
    })}\n`
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    die(5, error instanceof Error ? error.message : String(error));
  });
}
