export type FileResult = {
  file: string;
  outcome: 'passed' | 'failed' | 'incomplete' | 'not-run';
  ms: number;
  reason?: string;
};
export function fileResults(
  file: string,
  entries: string[],
  barrel?: string | null,
  registration?: { file: string; name: string }[] | null
): FileResult[];
