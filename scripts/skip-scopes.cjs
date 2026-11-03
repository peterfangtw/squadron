// The scope a skip or todo reason opens with, read by the lint rule
// (`eslint-skip-reason.cjs`) and the run summary (`skip-reporter.mjs`).
// CommonJS, because `eslint.config.js` is and requires this.

/** Where the reason fires, when the platform is why. `posix` is darwin and linux. */
const PLATFORMS = ['win32', 'darwin', 'linux', 'posix'];

/**
 * Where it fires for any other reason: `env` is the machine or the run (root,
 * an earlier step failed), `capability` is the case under test lacking what
 * the test needs (a port with no backlog).
 */
const CONDITIONS = ['env', 'capability'];

const PLATFORM_LIST = `(?:${PLATFORMS.join('|')})(?:, (?:${PLATFORMS.join('|')}))*`;
const SCOPED = new RegExp(`^(${PLATFORM_LIST}|${CONDITIONS.join('|')}): \\S`);

/** `win32`, `win32, linux` or `env` off a reason, or undefined when it has none. */
function scopeOf(reason) {
  return typeof reason === 'string' ? SCOPED.exec(reason)?.[1] : undefined;
}

/** What a reason should look like, for the lint message. */
const GRAMMAR = `"<scope>: <why>", scope one of ${[...PLATFORMS, ...CONDITIONS].join(', ')} (platforms may be listed: "win32, linux")`;

module.exports = { PLATFORMS, CONDITIONS, scopeOf, GRAMMAR };
