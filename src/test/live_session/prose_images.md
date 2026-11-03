# Live: a reply that names a picture draws it

## Purpose

An assistant turn whose own prose holds `![alt](path)` reaches the dock as a
chip that opens the picture — on both brands, from two different readers.

## Proves what `check` cannot

The whole chain, and it has never been walked in one go: a turn the model wrote
→ the brand's own file on disk → that brand's reader minting an `f|` ref →
`onDisk` weighing the file → the chip → `openImage`'s editor tab.

`chat_media.test.ts` hand-builds a view with an `f|` id, so it is green whether
or not `core/claude/transcript.ts` or `core/grok/tee.ts` ever emits one — the
seam between the two halves has no test on either brand. Everything past the
ref imports `vscode`: the `tooLarge` stat gate, the `withoutPaths` role scoping
and the editor tab are `host/session_io.ts`, which the unit suite cannot reach
and smoke has no case for.

The two readers are also genuinely different code. `core/prose_images.ts` is
shared, but Claude's caller has a uuid and a `cwd` from the transcript entry and
Grok's has neither — `grok/tee.ts` supplies stand-ins and mints an id carrying
the session id. A Claude-green pass says nothing about Grok's.

## Cost

One spawned target, ~2 turns, plus the driver's own reply. **Already mixes
brands**: the driver answers in its own brand and the target answers in the
other, so one run exercises both readers. Swapping which brand drives adds
nothing to this claim. Under a minute of wall clock.

No sends, so the pair cap does not apply and this one is safe to re-run
immediately.

## Preconditions

- The build under test is **deployed** (`npm run deploy`) and **every window has
  been reloaded**. The Grok half is `b5c317b`, first tagged in `v2026.34.19`; a
  window still running an older host draws the raw path on Grok and the row
  fails for the wrong reason.
- `squadron.orchestrators.enabled` is **on**.
- The panel is **open with both cards visible**. Every row but the first is
  something only a person looking at the dock can check — the sessions have no
  view of the panel, and the `f|` refs never touch disk.

## Prompt

Paste into a fresh **Grok** session (or a fresh Claude one — swap the two brand
names in step 2 and step 3 if you do).

```
You are driving a live test of how Squadron's dock draws a picture a reply
names. Work only in /tmp/agentsview-probe — create it if it does not exist. Do
not touch any repository, do not edit any file outside that directory, and do
not run any build or test command.

Step 1. Write the picture the test points at. It is generated rather than
copied so this needs nothing from any checkout:

  mkdir -p /tmp/agentsview-probe && python3 -c "
  import zlib,struct
  W,H=320,180
  rows=b''
  for y in range(H):
      row=b''
      for x in range(W):
          on=(x//40+y//40)%2
          row+=bytes((255 if on else 40, 90 if on else 160, 200))
      rows+=b'\x00'+row
  def chunk(t,d):
      c=t+d
      return struct.pack('>I',len(d))+c+struct.pack('>I',zlib.crc32(c))
  png=(b'\x89PNG\r\n\x1a\n'
       +chunk(b'IHDR',struct.pack('>IIBBBBB',W,H,8,2,0,0,0))
       +chunk(b'IDAT',zlib.compress(rows,9))
       +chunk(b'IEND',b''))
  open('/tmp/agentsview-probe/probe.png','wb').write(png)
  "

Confirm it with `file /tmp/agentsview-probe/probe.png` — it must say PNG image
data, 320 x 180. Print that line.

Step 2. Spawn a Claude target that will do one thing:

  ~/.squadron/bin/squadron-spawn --cwd /tmp/agentsview-probe \
    --brand claude --name live-prose-image-target \
    --prompt 'Reply with a markdown image so the dock can render it. Use this
    exact syntax, not a code fence, not a link:

    ![probe](/tmp/agentsview-probe/probe.png)

    One short reply. Include that image markdown in the body of your answer. Do
    not wrap it in backticks. Do not describe the file instead of showing it.
    After the image, one sentence is enough.'

Note the pid it prints — call it TARGET.

Step 3. Now do the same thing yourself, in your own reply, so your own card is
the second half of this test. End your report with exactly this line, on its
own, not in a code fence:

  ![probe](/tmp/agentsview-probe/probe.png)

Step 4. Wait about fifteen seconds, then find the target's transcript with
`~/.squadron/bin/squadron-list` and print its assistant turns. Say plainly
whether the string ![probe]( appears in one of them.

Report each step's result as you go. Do not stop the target — the human will.
```

The prompt is that blunt on purpose. A model told only "show an image" reaches
for a fenced sample or describes the file instead, and `CODE_MD` is right to
leave a fenced sample alone — so a vague instruction fails this scenario without
anything being wrong with the feature.

## Validation

| # | Check | Where | Pass |
| --- | --- | --- | --- |
| 1 | The turn was written at all | the session's own report of step 4 | an assistant turn in the target's transcript holds `![probe](/tmp/agentsview-probe/probe.png)` |
| 2 | **Human:** the Claude card draws a chip | select the target's card, its last assistant turn | a chip, **not** the raw path and **not** a broken picture |
| 3 | **Human:** the Grok card draws a chip | select the driving session's card, its last turn | same chip, on the driver's own brand |
| 4 | **Human:** the chip opens | click each | a thumbnail of the 320×180 blue-and-orange checkerboard |
| 5 | **Human:** the click reaches the host | click the opened preview | the picture full size in an editor tab |
| 6 | **Human:** the prose was cleaned | the same two turns | neither body still shows `![` or the path |

Rows 2 and 3 are the pair that matters: same feature, two readers, and only row
3 covers `grok/tee.ts`. Row 5 is the only row that touches `openImage`, which
nothing else in the suite reaches.

## Cleanup

```sh
~/.squadron/bin/squadron-end --pid <TARGET>
rm -rf /tmp/agentsview-probe
```

Stop the target **after** the panel rows, not before — a stopped card cannot be
inspected for rows 2, 4, 5 or 6.

## Results

| Date | Build | Brand | Result | Notes |
| --- | --- | --- | --- | --- |
| 2026-08-23 | 2026.34.20 deployed | Grok `grok-4.6-build` | rows 1–3, 6 pass; 4–5 unchecked | **Back-filled, not a run of this prompt** — this file did not exist yet. Session `01a02e78-bda2-7db1-8e23-e3111050acd6` at 19:55 pointed at the checked-in `docs/reference/panel_notices/toast-waiting.png` instead of a generated probe, and drew the chip on its own card. Same chain, different picture |
| 2026-08-23 | 2026.34.20 deployed | Claude | rows 1–3, 6 pass; 4–5 unchecked | Same run: the Grok session above spawned `4ecd2744-c803-4611-b457-4005f40435e7` (`image-in-chat verify`), which emitted the image at 20:11 and drew the chip. Rows 4–5 went unchecked on both — nobody clicked through, so `openImage`'s editor tab is still unexercised on either brand |
