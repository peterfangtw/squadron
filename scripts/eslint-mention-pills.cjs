// A blanket disable suppresses its own rejecting rule. Publish directive
// diagnostics after ESLint applies suppressions, using its parsed comments.
const directives = new Map();
const processor = {
  meta: { name: 'squadron/mention-directives', version: '1' },
  supportsAutofix: true,
  preprocess(text, filename) {
    directives.set(filename, []);
    return [text];
  },
  postprocess(messages, filename) {
    const extra = directives.get(filename) ?? [];
    directives.delete(filename);
    return [...messages.flat(), ...extra];
  }
};

/** Mention markup belongs to the editor atom and the shared chat renderer. */
const boundary = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      shared:
        'Construct mention pills through prose.ts or mention_pill.ts. A scoped exception needs an explanation.'
    }
  },
  create(context) {
    const check = (node, value) => {
      if (typeof value === 'string' && /(^|[\s"'])(pchip|sref)(?=[\s"']|$)/u.test(value))
        context.report({ node, messageId: 'shared' });
    };
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked)
    };
  }
};

const exceptionReason = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      reason:
        'A mention-pills exception must name its rule, use eslint-disable-next-line, and include -- followed by its reason.'
    }
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const text = comment.value.trim();
          const disable = /^eslint-disable(?:-next-line|-line)?\b(.*)$/su.exec(text);
          if (!disable) continue;
          const rules = (disable[1] ?? '').split(/\s--(?:\s|$)/u)[0]?.trim();
          if (rules && !rules.split(/[,\s]+/u).includes('squadron/mention-pills')) continue;
          if (rules && /^eslint-disable-next-line\b[^\n]*\s--\s+\S/u.test(text)) continue;
          const queued = directives.get(context.filename);
          if (queued)
            queued.push({
              ruleId: 'squadron/mention-exception-reason',
              severity: 2,
              message: exceptionReason.meta.messages.reason,
              line: comment.loc.start.line,
              column: comment.loc.start.column + 1,
              endLine: comment.loc.end.line,
              endColumn: comment.loc.end.column + 1
            });
          else context.report({ loc: comment.loc, messageId: 'reason' });
        }
      }
    };
  }
};

module.exports = {
  processor,
  rules: { 'mention-pills': boundary, 'mention-exception-reason': exceptionReason }
};
