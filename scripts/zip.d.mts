export function entry(file: string, name: string): Buffer;
export function names(file: string): string[];
export function extract(file: string, prefix: string, dir: string): number;
export function replace(file: string, name: string, bytes: Buffer): void;
