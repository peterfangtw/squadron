# Separate sessions

A lane is one persistent session, reused for all its steps. Steps without
`lane` belong to the session at which the workflow is started: the coordinator
(called `anchor` in code). Every runnable workflow needs at least one such
step. Use named lanes for work that benefits from another session, such as an
independent review; a change of label is not a change of context.

## Open, reuse, join

A named lane's first step opens its session after its prerequisites finish.
Every named-lane step needs a wired prerequisite; a lane root with none is
refused when starting the run. The coordinator's next-step pull opens ready
lanes. Author the edges and let the runner open them: a prompt that also spawns
the same worker would create duplicate sessions.

Put `brand`, `model`, and `effort` only on a named lane's first step when the
user needs particular choices. A model needs a brand; omit both to inherit.
Obtain actual available model ids through the `squadron` skill's model
discovery when specifying them. A later step reuses the lane's session and
model. Use another lane when fresh context or a different model is required.
The runner may fall back when the selected model cannot start, so a definition
does not prove which model performed the work.

Within every session, chain its steps. At a join, wait for each worker's final
required step and for the coordinator's previous step. All dependency ids must
precede the dependent in the array. For example:

```json
{
  "id": "parallel-reviews",
  "label": "Parallel reviews",
  "lanes": ["Correctness", "Simplicity"],
  "steps": [
    {
      "id": "brief",
      "label": "Record review brief",
      "prompt": "Read the user's review request and repository instructions. Record the exact diff baseline, scope, pre-existing changes, and acceptance criteria in this session's reply. Finish when reviewers can identify the complete review target from that record."
    },
    {
      "id": "correctness",
      "label": "Review correctness",
      "lane": "Correctness",
      "needs": ["brief"],
      "prompt": "Read the coordinator's recorded review brief through its transcript. Review the specified diff for correctness without editing. Finish with actionable findings and file locations, or an explicit no-findings result and coverage limits."
    },
    {
      "id": "simplicity",
      "label": "Review simplicity",
      "lane": "Simplicity",
      "needs": ["brief"],
      "prompt": "Read the coordinator's recorded review brief through its transcript. Review the specified diff for unnecessary complexity without editing. Finish with concrete simplifications and reasons, or an explicit no-findings result and coverage limits."
    },
    {
      "id": "synthesize",
      "label": "Synthesize findings",
      "needs": ["brief", "correctness", "simplicity"],
      "prompt": "Read both review lanes' transcripts. Assess their findings against the actual code, resolve contradictions, and report supported findings to the user. Finish when both reviews are accounted for and any unresolved disagreement is identified."
    }
  ]
}
```

## Handoffs

Choose files with declared output paths for structured deliverables. For
dynamic paths or short findings, require a producer to record the brief and
artifact paths in its transcript before completing its step.

A new lane is a fresh conversation in the same working directory. For a
transcript handoff, add enough instruction to identify its source: its initial
briefing names the coordinator's session id, and the `squadron` skill explains
listing sessions and reading the returned transcript paths. The coordinator can
locate its lane children through the same skill. Read written reports before
requesting more work. A question needed before continuing must interrupt rather
than sit behind the recipient's dependency wait; execution mechanics stay in
`squadron`.

**Check each handoff:** the consumer can locate the source from its own context,
the producer writes everything the consumer needs before finishing, concurrent
writers use different artifacts, and the join waits for all required results.
