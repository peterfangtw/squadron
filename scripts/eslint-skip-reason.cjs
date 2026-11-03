// Every skip or todo in a test names where it fires, so a run's summary can
// count them by scope and `grep '# win32:'` on a spec log lists one platform's.
// The grammar is `skip-scopes.cjs`'s; `src/test/AGENTS.md` says what each means.

const { scopeOf, GRAMMAR } = require('./skip-scopes.cjs');

/** The callees whose options object takes `skip` and `todo`, alone or chained (`test.describe`). */
const TEST_FNS = new Set(['it', 'test', 'describe', 'suite']);
/** A constant holding a reason, like `modeBitsSkip` or `lsofTodo`. */
const HOLDER = /(Skip|Todo)$/;

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'A test skip or todo opens its reason with the scope it fires on' },
    schema: [],
    messages: {
      unscoped: `A skip or todo reason reads ${GRAMMAR}.`,
      bare: 'A bare condition gives no reason. Write `<condition> && "<scope>: <why>"`.',
      method: '`{{call}}()` takes no reason. Pass `{ {{kind}}: "<scope>: <why>" }` instead.'
    }
  },
  create(context) {
    return {
      CallExpression(node) {
        const chain = testChain(node.callee);
        if (chain) {
          const kind = chain.find((name) => name === 'skip' || name === 'todo');
          if (kind)
            context.report({ node, messageId: 'method', data: { call: chain.join('.'), kind } });
          else for (const arg of node.arguments) if (arg.type === 'ObjectExpression') options(arg);
          return;
        }
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') return;
        const kind = callee.property.name;
        if (kind !== 'skip' && kind !== 'todo') return;
        if (callee.object.type === 'Identifier' && isTestContext(callee.object))
          check(node.arguments[0], node);
      },
      VariableDeclarator(node) {
        if (node.id.type !== 'Identifier' || !HOLDER.test(node.id.name) || !node.init) return;
        // `shouldSkip = files.length === 0` is a flag, not a reason; a holder carries a string.
        const annotation = node.id.typeAnnotation;
        const annotated = annotation && context.sourceCode.getText(annotation).includes('string');
        if (annotated || carriesString(node.init)) check(node.init, node);
      }
    };

    function options(object) {
      for (const prop of object.properties) {
        if (prop.type !== 'Property') continue;
        const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;
        if (key === 'skip' || key === 'todo') check(prop.value, prop);
      }
    }

    /** Reports what `value` can evaluate to that is not a scoped reason or `false`. */
    function check(value, at) {
      if (!value) return void context.report({ node: at, messageId: 'bare' });
      switch (value.type) {
        case 'Literal':
          if (value.value === true) context.report({ node: value, messageId: 'bare' });
          else if (typeof value.value === 'string' && !scopeOf(value.value))
            context.report({ node: value, messageId: 'unscoped' });
          return;
        case 'TemplateLiteral': {
          const head = value.quasis[0]?.value.cooked ?? '';
          // Opening on an interpolation, like `${processTableTodo}/W3.2b`, inherits its scope.
          if (value.expressions.length > 0 && head === '') return;
          // `x` stands in for the interpolation after `win32: `, so the grammar's `\S` can match.
          if (!scopeOf(value.expressions.length > 0 ? head + 'x' : head))
            context.report({ node: value, messageId: 'unscoped' });
          return;
        }
        case 'LogicalExpression':
          if (value.operator !== '&&') check(value.left, at);
          return check(value.right, at);
        case 'ConditionalExpression':
          check(value.consequent, at);
          return check(value.alternate, at);
        case 'BinaryExpression':
        case 'UnaryExpression':
          return void context.report({ node: value, messageId: 'bare' });
        case 'TSAsExpression':
        case 'TSSatisfiesExpression':
          return check(value.expression, at);
        default:
          // A name or a call: checked where it is defined, and counted at run time.
          return;
      }
    }

    /** `t` in `it('…', (t) => { t.skip(…) })` or `boot.step('…', (t) => …)`. */
    function isTestContext(identifier) {
      const variable = context.sourceCode
        .getScope(identifier)
        .references.find((ref) => ref.identifier === identifier)?.resolved;
      const def = variable?.defs[0];
      if (def?.type !== 'Parameter') return false;
      const call = def.node.parent;
      if (call?.type !== 'CallExpression') return false;
      const callee = call.callee;
      const step =
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'step';
      return step || testChain(callee) !== undefined;
    }
  }
};

/** `['test', 'describe', 'skip']` for `test.describe.skip`, or undefined for any other callee. */
function testChain(callee) {
  const names = [];
  let node = callee;
  while (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier'
  ) {
    names.unshift(node.property.name);
    node = node.object;
  }
  if (node.type !== 'Identifier' || !TEST_FNS.has(node.name)) return undefined;
  const chained = names.every(
    (name) => TEST_FNS.has(name) || ['only', 'skip', 'todo'].includes(name)
  );
  return chained ? [node.name, ...names] : undefined;
}

/** Whether a holder's initializer can evaluate to a string at all. */
function carriesString(node) {
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string';
    case 'TemplateLiteral':
      return true;
    case 'LogicalExpression':
      return carriesString(node.left) || carriesString(node.right);
    case 'ConditionalExpression':
      return carriesString(node.consequent) || carriesString(node.alternate);
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
      return carriesString(node.expression);
    default:
      return false;
  }
}
