---
name: squadron-heavy-runs
description: >
  Take turns with the other agent sessions on this machine before running
  something heavy. Use before a full test suite, a build, a repo's local CI or
  check script, or any command that keeps every core busy for minutes — in any
  repo. Not for dev servers, watchers, lint, or a single test file.
user-invocable: true
disable-model-invocation: false
---

# Heavy runs

Other sessions on this machine, in this repo and in others, run their suites
whenever their own work gets there. Two full suites at once finish no sooner
than one after the other: each runs slower, timeouts flake, and a flake reads as
a real failure you then spend turns chasing. One lock file per user is the
machine's one slot for heavy work. Look before you run; queue what is heavy.

## Look

```sh
ps -Ao pid,etime,command | awk '$3 ~ /(^|\/)(lockf|flock)$/ && /heavy\.lock/'
uptime; sysctl -n hw.ncpu        # Linux: nproc
ps -Ao pid,pcpu,etime,command -r | head -8
```

- Each line of the first command is one queued run, and `etime` is how long
  ago it asked. The one with a child process holds the slot; on macOS that is
  the oldest, and the rest follow in the order they asked.
- Load well above the core count with no `heavy.lock` line means someone is
  running heavy work without the lock. The lock does not wait for it; holding
  off is your call.

## Decide

| Queue it | Just run it |
| --- | --- |
| A full test suite | One test file, one test |
| A build of the whole project | Lint, format, typecheck of a few files |
| The repo's `check`, `ci` or pre-push script | A dev server or a watcher |
| Anything that keeps every core busy for over a minute | Anything that does not end on its own |

**Never put a command that does not end under the lock.** A dev server or a
watcher would hold the slot until someone kills it, and every session behind it
waits the full 45 minutes.

## Queue

macOS:

```sh
lockf -k -t 2700 ~/.squadron/heavy.lock npm run check
```

Linux: `flock -w 2700 ~/.squadron/heavy.lock npm run check`.

- **Run it in the background** with your shell tool's own background mode. The
  wait counts against a foreground call's timeout. Carry on with other work;
  you are told when it ends.
- **The command is run directly, not by a shell.** For pipes, `&&` or
  redirects, wrap it: `lockf -k -t 2700 ~/.squadron/heavy.lock sh -c 'npm test | tee test.log'`.
- **Output and exit code are the command's own.** Exit **75** means 45 minutes
  passed without the slot and the command never ran. Say so and look again;
  do not loop on it.
- **Keep `-k`.** It keeps the file, and the waiters keep their order. Never
  delete the lock file, and never kill another session's `lockf`.
- **Do not take the lock inside the lock.** A command already under it that
  takes it again waits for itself until the timeout.
- The slot is freed when the command exits, however it exits. A session that
  dies holding it frees it too.

When you queue, say what you are behind: *queued behind `pnpm test` in another
repo, 4 min in*.

## Windows

There is no lock yet. Look and decide:

```powershell
Get-Process | Sort-Object CPU -Descending | Select-Object -First 8
```
