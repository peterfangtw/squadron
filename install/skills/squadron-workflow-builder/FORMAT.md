# Workflow file contract

Observed in Squadron on 2026-10-03. Source of truth, when its checkout is
available: `src/core/workflows/workflows.ts` (`Workflow`, `Step`, `validate`,
`armable`), `authoring.ts` (`structuralReasons`, `unopenedLanes`), and
`progress.ts` (`stepBody`). Recheck those boundaries when the installed version
differs; PRDs can describe behavior the runner has not implemented.

## File and steps

One JSON object at `~/.squadron/workflows/<id>.json`:

| Field | Meaning |
| --- | --- |
| `id` | Stable workflow id. Use a lowercase slug matching the new filename. |
| `label` | Name shown to the user. |
| `description` | Optional explanation and prerequisites. |
| `steps` | Nonempty array, with producers before their dependents. |
| `lanes` | Optional display order of named lanes; steps define membership. |

Each step has a unique `id`, a nonempty `label`, and exactly one body:

- `prompt`: instructions, including acceptance and any required artifacts.
- `uses`: an installed slash command or skill name, such as `/review`.
  It is served as "Run the /review command." Use a prompt when parameters,
  prerequisites, or extra completion criteria need to accompany the skill.

`needs` lists earlier step ids that must finish. Write explicit dependencies
for new workflows, including a chain: file order alone is not a general
execution rule. Every later step in the same session must depend, directly or
transitively, on that session's previous step.

Legacy compatibility: a file with at most one lane and no nonempty `needs`
anywhere is read as a chain in file order. Once any dependency is stated, or
several lanes appear, omitted `needs` means no prerequisites.

## Templates and artifacts

The current pull runner substitutes only:

- `${cwd}`: the directory from which the session pulls its step.
- `${step.<id>.output}`: the earlier step's declared `output` string, a path.

An `output` declaration neither creates a file nor captures a reply. The
producer's prompt must require writing it. Put its producer in the consumer's
dependency ancestry as well as earlier in the array. Choose paths consistent
with the target project's conventions; concurrent runs need distinct artifact
paths or a different handoff arrangement.

Ticket variables such as `${title}`, `${identifier}`, and `${url}` occur in
older contracts but are not filled by this runner. Unknown variables remain
literal. Refer to the user's task message for the subject instead.

```json
{
  "id": "plan-and-implement",
  "label": "Plan and implement",
  "steps": [
    {
      "id": "plan",
      "label": "Write plan",
      "output": "docs/tasks/current-plan.md",
      "prompt": "Read the user's task and repository instructions in ${cwd}. Establish acceptance criteria and required checks. Write the implementation plan to docs/tasks/current-plan.md. Finish when the file records the settled scope, ordered changes, and checks; resolve critical unknowns with the user."
    },
    {
      "id": "implement",
      "label": "Implement and verify",
      "needs": ["plan"],
      "prompt": "Read ${step.plan.output} and implement the settled plan in ${cwd}. Run its required checks. Finish when each acceptance criterion has evidence; report any check that could not run."
    }
  ]
}
```

The example path assumes one run in this checkout and a project that uses
`docs/tasks/`; adapt it to the target project.

## Checks and failures

`check`, `advance`, `onFail`, and `retries` are retained file fields, but the
current runner does not execute a check command or implement those policies.
Keep existing values when editing; express required behavior in step prompts
when authoring. Completion is the agent's explicit report, not proof supplied
by the host. A step that cannot finish remains unfinished and the agent reports
the blocker to the human.

## Validation

Run the installed command on the candidate before saving it as a workflow:

```sh
~/.squadron/bin/workflow-validation --file-path /path/to/candidate.json --cwd-path /path/to/target-repo --brand codex
```

That is the POSIX and Git Bash form. In Windows PowerShell, run the `.cmd`
beside it and write each value as `'"value"'`; in cmd, double-quote each value:

```powershell
& "$HOME\.squadron\bin\workflow-validation.cmd" --file-path '"C:\path\to\candidate.json"' --cwd-path '"C:\path\to\target-repo"' --brand '"codex"'
```

The `squadron` skill's Running a verb section gives the limits of those forms
and `--argv-file`, which this command reads too.

`--file-path` is required. Both paths resolve from the invoking directory;
`--cwd-path` defaults to that directory and determines where project skills are looked up,
from that directory up to its repository root. `--brand` (`claude`, `codex` or
`grok`) is the CLI of the session the workflow will be started in. Each `uses`
is looked up in the skill folders of the CLI that runs its step: that brand,
or the `brand` on the step that opens a lane. Without `--brand`, a `uses` that
runs in the starting session is reported as needing it. A `uses` names a skill
by its frontmatter `name`, not its folder. Legacy Claude command files use
their relative path instead (`commands/team/ship.md` is `/team:ship`); Grok
compatibility commands use frontmatter names when present. Case does not matter.
The command reads files and returns one JSON object with `ok`, absolute `file`
and `cwd` paths, and a `reasons` array. It starts no session and writes no run.
Fix every reported reason and rerun until `ok` is true and the exit code is 0.

| Exit | Meaning |
| --- | --- |
| 0 | Validation passed. |
| 1 | Invalid command arguments; usage is on stderr. |
| 2 | Invalid JSON, invalid definition, unreadable file, or unusable target directory; reasons are in stdout JSON. |
| 5 | Unexpected command failure, reported on stderr. |

It uses the same definition normalization, field validation, and armability
checks as Squadron. Legacy chains get their implicit dependencies; stale
`schema` keys and invalid display-only `lanes` lists are ignored by that
normalization. It checks required fields and known optional field types,
dependencies, lane ordering, declared output references, at least one
starting-session step, wired named lanes, and `uses` availability.

Currently the unqualified `uses` lookup checks Claude's global/project commands
and skills; plugin-qualified names pass without lookup. Verify availability for
the intended executing CLI separately. Unknown extra fields, unsupported prompt
templates, model/account entitlement, artifact creation, and prompt semantics
are not proven by a passing result. Inspect templates and handoffs yourself.

In a built source checkout the same command can be run directly:

```sh
node /path/to/squadron/dist/workflow-validation.js --file-path /path/to/candidate.json --cwd-path /path/to/target-repo
```

If the installed command is missing, update Squadron and reload its window;
activation installs the bundled command. Keep the candidate as a draft until
it can be validated. A live workflow start is not a validation probe.
