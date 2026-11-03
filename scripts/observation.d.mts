export type Outcome = 'passed' | 'failed' | 'cancelled' | 'incomplete' | 'reused' | 'skipped';
export type Span = {
  id: string | null;
  end(outcome: Outcome, details?: Record<string, unknown>): void;
};
export function mode(): string;
export function configure(directory: string): string | null;
export function start(name: string, details?: Record<string, unknown>): Span;
export function event(name: string, details?: Record<string, unknown>): void;
export function measure<T>(name: string, work: () => T, details?: Record<string, unknown>): T;
export function flush(): void;
export function write(file: string, record: unknown): boolean;
export function identity(root?: string, archive?: string | null): Record<string, unknown>;

export function prune(root: string): void;
export function createRun(label: string): string;

export function failActive(): void;
