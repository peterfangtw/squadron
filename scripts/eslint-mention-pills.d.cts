import type { Rule, Linter } from 'eslint';
export const rules: Record<'mention-pills' | 'mention-exception-reason', Rule.RuleModule>;

export const processor: Linter.Processor;
