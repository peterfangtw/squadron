// Portability rules `src/test/AGENTS.md` (Windows) states in prose. Each
// matches known syntax over a module's declared binding: a namespace, default
// or named import, `import x = require()`, `require()`, `await import()`, a
// destructure of one, or a `const` initialised from one. A parameter, a later
// assignment, `globalThis` and `.default` are not followed — the runtime guards
// in `test/home.ts` stay the safety net.

const OS_READS = { os: ['platform', 'type'], process: ['platform'] };
const HOME_KEYS = new Set(['HOME', 'USERPROFILE']);
const FS_MODULES = new Set(['fs', 'fs/promises']);
const MKDTEMP = new Set(['mkdtemp', 'mkdtempSync']);
const PATH_MODULES = new Set(['path']);
const PATH_JOINS = new Set(['join', 'resolve']);
/** POSIX root, win32 backslash root, or a drive letter. */
const ABSOLUTE = /^([\\/]|[A-Za-z]:)/;

/** @type {import('eslint').Rule.RuleModule} */
const osRead = {
  meta: {
    type: 'problem',
    docs: { description: 'The OS is read in core/platform/host.ts and test/home.ts only' },
    schema: [],
    messages: {
      read: 'Select OS mechanisms in core/platform; tests use test/helpers.testPlatform().'
    }
  },
  create(context) {
    const code = context.sourceCode;
    const reads = (module, name) => OS_READS[module]?.includes(name) ?? false;
    return {
      MemberExpression(node) {
        if (reads(moduleOf(code, node.object), keyOf(node))) report(node);
      },
      ImportSpecifier(node) {
        // A type import reads nothing at run time.
        if (node.importKind === 'type' || node.parent.importKind === 'type') return;
        if (reads(normal(node.parent.source.value), nameOf(node.imported))) report(node);
      },
      VariableDeclarator(node) {
        if (node.id.type !== 'ObjectPattern' || !node.init) return;
        const module = moduleOf(code, node.init);
        for (const prop of node.id.properties)
          if (prop.type === 'Property' && reads(module, keyOf(prop))) report(prop);
      }
    };
    function report(node) {
      context.report({ node, messageId: 'read' });
    }
  }
};

/** @type {import('eslint').Rule.RuleModule} */
const homeWrite = {
  meta: {
    type: 'problem',
    docs: { description: 'A test moves the home only through the shared composers' },
    schema: [],
    messages: {
      write:
        'Move the home with tempHome() and hand a child homeEnv(home); smoke uses boot.homeVars(). ' +
        'win32 reads USERPROFILE, so a lone HOME leaves the real home in reach.'
    }
  },
  create(context) {
    return {
      'ObjectExpression > Property'(node) {
        if (HOME_KEYS.has(keyOf(node))) context.report({ node, messageId: 'write' });
      },
      // Any object: `process.env.HOME = h` and `env.HOME = h` on a child's copy alike.
      AssignmentExpression(node) {
        const left = node.left;
        if (left.type === 'MemberExpression' && HOME_KEYS.has(keyOf(left)))
          context.report({ node, messageId: 'write' });
      }
    };
  }
};

/** @type {import('eslint').Rule.RuleModule} */
const tempRoot = {
  meta: {
    type: 'problem',
    docs: { description: 'A temp directory is made under os.tmpdir()' },
    schema: [],
    messages: {
      root: 'Make the prefix path.join(os.tmpdir(), name): an absolute literal names no temp directory on win32.'
    }
  },
  create(context) {
    const code = context.sourceCode;
    return {
      CallExpression(node) {
        if (!isMkdtemp(node.callee)) return;
        const root = staticRoot(node.arguments[0]);
        if (root !== undefined && ABSOLUTE.test(root))
          context.report({ node: node.arguments[0], messageId: 'root' });
      }
    };

    function isMkdtemp(callee) {
      return calls(callee, FS_MODULES, MKDTEMP);
    }

    /** `callee` is one of `names` exported by one of `modules`, as a member or a named binding. */
    function calls(callee, modules, names) {
      if (callee.type === 'MemberExpression')
        return names.has(keyOf(callee)) && modules.has(moduleOf(code, callee.object));
      if (callee.type !== 'Identifier') return false;
      const bound = bindingOf(code, callee);
      return bound !== undefined && modules.has(bound.module) && names.has(bound.name);
    }

    /** The literal text a path expression starts with, when the source fixes it. */
    function staticRoot(node) {
      if (!node) return undefined;
      if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : undefined;
      if (node.type === 'TemplateLiteral') return node.quasis[0]?.value.cooked ?? undefined;
      if (node.type === 'BinaryExpression' && node.operator === '+') return staticRoot(node.left);
      if (node.type === 'CallExpression' && calls(node.callee, PATH_MODULES, PATH_JOINS))
        return staticRoot(node.arguments[0]);
      return undefined;
    }
  }
};

/** The core module `node` evaluates to, `'node:'` dropped, or undefined. */
function moduleOf(code, node) {
  if (!node) return undefined;
  if (node.type === 'Identifier') {
    const variable = variableOf(code, node);
    // `process` with no declaration in scope is Node's global.
    if (!variable || variable.defs.length === 0)
      return node.name === 'process' ? 'process' : undefined;
    const bound = bindingOf(code, node);
    return bound && bound.name === undefined ? bound.module : undefined;
  }
  if (node.type === 'AwaitExpression') return moduleOf(code, node.argument);
  if (node.type === 'ImportExpression') return literalModule(node.source);
  if (node.type === 'CallExpression')
    return node.callee.type === 'Identifier' && node.callee.name === 'require'
      ? literalModule(node.arguments[0])
      : undefined;
  if (node.type === 'MemberExpression' && keyOf(node) === 'promises')
    return moduleOf(code, node.object) === 'fs' ? 'fs/promises' : undefined;
  return undefined;
}

/**
 * What an identifier was declared as: a whole module (`name` undefined), or
 * one export of it (`import { mkdtemp } from 'fs'`, `const { mkdtemp } = fs`).
 */
function bindingOf(code, id) {
  const def = variableOf(code, id)?.defs[0];
  if (!def) return undefined;
  if (def.type === 'ImportBinding') {
    // typescript-eslint records `import x = require('m')` as an import binding too.
    if (def.node.type === 'TSImportEqualsDeclaration') {
      const reference = def.node.moduleReference;
      const module =
        reference.type === 'TSExternalModuleReference'
          ? literalModule(reference.expression)
          : undefined;
      return module && { module, name: undefined };
    }
    const module = normal(def.parent.source.value);
    if (def.node.type !== 'ImportSpecifier') return { module, name: undefined };
    return exported(module, nameOf(def.node.imported));
  }
  if (def.type !== 'Variable' || !def.node.init) return undefined;
  const { id: pattern, init } = def.node;
  if (pattern.type === 'Identifier') {
    const module = moduleOf(code, init);
    return module && { module, name: undefined };
  }
  if (pattern.type !== 'ObjectPattern') return undefined;
  const module = moduleOf(code, init);
  const prop = pattern.properties.find(
    (p) => p.type === 'Property' && p.value.type === 'Identifier' && p.value.name === id.name
  );
  return module && prop ? exported(module, keyOf(prop)) : undefined;
}

/** One export of `module`; fs's `promises` is the promises module, whole. */
function exported(module, name) {
  return module === 'fs' && name === 'promises'
    ? { module: 'fs/promises', name: undefined }
    : { module, name };
}

function variableOf(code, id) {
  for (let scope = code.getScope(id); scope; scope = scope.upper) {
    const variable = scope.set.get(id.name);
    if (variable) return variable;
  }
  return undefined;
}

/** A property or member key known at parse time: `a.b`, `a['b']`, `{ ['b']: 1 }`. */
function keyOf(node) {
  const key = node.type === 'MemberExpression' ? node.property : node.key;
  if (!node.computed) return nameOf(key);
  if (key.type === 'Literal') return typeof key.value === 'string' ? key.value : undefined;
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0)
    return key.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

function nameOf(node) {
  if (node.type === 'Identifier') return node.name;
  return node.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}

function literalModule(node) {
  return node && node.type === 'Literal' && typeof node.value === 'string'
    ? normal(node.value)
    : undefined;
}

function normal(source) {
  return source.startsWith('node:') ? source.slice(5) : source;
}

module.exports = { rules: { 'os-read': osRead, 'home-write': homeWrite, 'temp-root': tempRoot } };
