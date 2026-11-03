---
name: squadron-workflow-builder
description: >
  Build Squadron workflow definitions. Use when creating a reusable workflow,
  editing an existing workflow's steps or dependencies, or turning a process
  into Squadron lanes. Running workflows and controlling sessions belong to
  the squadron skill.
user-invocable: true
disable-model-invocation: false
---

# Squadron Workflow Builder

Build the definition; the session following it will receive one step at a time.
This skill owns workflow JSON, step instructions, dependencies, and handoffs.
The `squadron` skill owns execution and its verb CLIs. Authoring a workflow
does not start its work or its sessions.

## 1. Settle the process

Establish the workflow's subject, intended result, and where it will run. Read
an existing definition before editing it and read any skills the steps will
invoke: their prerequisites and human gates become part of the process.
Use the user's stated sequence and session choices. Ask only about missing
decisions that change the work, such as whether a review needs fresh context.

A reusable workflow takes its subject from the task message. Keep a particular
ticket, branch, and task's files out of the definition unless the user wants a
workflow specifically for them.

**Done:** every requested stage has a purpose and a verifiable result; critical
decisions are settled or explicitly left for the executing step to resolve.

## 2. Wire the steps

Keep step prompts concise. Use bullets or fragments when unambiguous.
Do not add words merely to form complete sentences. Omit repeated
instructions. Preserve actors, conditions, dependencies, and completion
criteria.

Read [FORMAT.md](FORMAT.md) for the current file contract. Start with one
session; when separate sessions are requested or needed for independent work,
also read [LANES.md](LANES.md).

Use dependencies to express the process. Each step's instruction must identify
the inputs it needs, the work it owns, and the evidence required before it can
be marked done. Put required tests and human decisions in that instruction.
The runner does not infer acceptance from a label such as "Verify".

For a handoff, specify what the producer writes and where the consumer reads
it. A dependency makes work ready; it does not carry conversation context.
Give each step enough information to work without reading future steps.

When editing, preserve stable ids and fields outside the requested change.
Update every affected dependency and output reference when a step changes.

**Done:** every step has an explicit completion criterion, every required input
has a producer or a stated source, and the graph expresses all required waits.

## 3. Validate and save

Write a candidate file and apply the validation procedure in FORMAT.md before
installing it. Verify referenced skills in the target environment and inspect
every template and handoff; structural validation alone does not check them.
Resolve failures in the definition, then validate the final candidate again.

Use the user's destination, otherwise `~/.squadron/workflows/<id>.json`.
For a new workflow, choose an unused id and matching filename; editing retains
the original path. Re-read an existing destination before replacing it so
concurrent edits are not silently lost. Save complete JSON through a temporary
file in the same directory and rename it into place, then read it back.

**Done:** the saved JSON matches the validated candidate, references resolve,
and all validation limits are recorded. Report the file, a compact account of
its sequence and lanes, and what was verified. Starting a run is a separate
request handled by `squadron`.
