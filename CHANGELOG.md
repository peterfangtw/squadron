# Changelog

<!--
Agents editing this changelog: write release notes for users.
Exclude internal-facing changes, including documentation, QA reports, test
infrastructure, verification evidence and agent instructions.
Summarize refactors in one brief line, such as "Refactoring for better
scalability", only when that benefit is supported; omit implementation details.
Do not add a release note for edits to this guidance.
-->

## 0.6.28

- Grok correctly shows signed out after logout leaves an empty credential file.

## 0.6.27

- Hub counts use consistent spacing and styling across all controls, including the overflow menu.
- Routines use consistent text sizes across their list, editor and empty states.

## 0.6.26

- Save repository Routines with daily, weekly or hourly reminders. Run them explicitly in the current window, and mark them complete from the associated session.
- Sessions above 80% context can receive messages, answers and wait results while agents manage their own compaction.
- Workflow insertion hints stay visible while dragging.

## 0.6.25

- Maintenance release.

## 0.6.24

- Fable 5.2 is available in the Claude model picker.
- Disconnecting Linear or GitHub Projects asks for confirmation first, from the board menu and from the command palette.
- Ticket column headers match the size of session group titles.

## 0.6.23

- Escape and clicks close only the topmost surface: a menu, image, dialog or sheet over the bottom drawer no longer closes the drawer underneath, and closing a picker returns focus to the control that opened it.
- The dock no longer offers Interrupt on a session that is ending, matching its card.
- A session start that fails or cannot be confirmed shows the same message on every surface.
- Ticket rows in the @ menu fit on one line.
- Sign-in status is kept separately for each configured CLI binary, so changing a CLI path re-reads its accounts.
- Refactoring for more reliable ticket sources and session starts.

## 0.6.22

- Connect Linear or GitHub Projects from one prompt in the Tickets tab, and connect, re-key or disconnect either source the same way from the board menu or the command palette.
- GitHub Projects tickets refresh every minute, like Linear's, and filter menus no longer go stale.
- Picking a board that is no longer available no longer leaves the Tickets tab stuck on Loading.

## 0.6.21

- GitHub Projects token setup states exactly which scopes private and public repository issues need, and what to check when GitHub hides project items.

## 0.6.20

- GitHub Projects setup guides classic token creation and explains when private repository issues need additional access.
- Empty ticket results and connection errors keep column headers in place; notices let every ticket scroll fully into view.

## 0.6.19

- Browse GitHub Projects tickets alongside Linear, open their details, and drag tickets into a session.
- The @ mention menu follows the cursor while composing a message.

## 0.6.18

- More reliable delivery of messages and workflow wake-ups between sessions.

## 0.6.17

- Maintenance release.

## 0.6.16

- Maintenance release.

## 0.6.15

- Expanded More pills keep a solid background when hovered.

## 0.6.14

- Copy ticket links from their details and paste them into the composer as ticket pills; ticket links in chat use the same labels.
- Sessions waiting for an answer appear under Agents on the bottom hub, with shortcuts to their chat and open request.
- The Sessions tab shows this window's total session count.
- Better alignment for the compact permission-mode icon.

## 0.6.13

- Start and resume sessions in an empty editor window without opening a folder.
- Newly added skills become available when opening the skill picker, without reloading the window.
- Session permission mode appears beside the model and effort on cards.
- More reliable session startup on Windows.

## 0.6.12

- Windows file-save failures return promptly instead of waiting through repeated attempts.
- Grok credential-save failures preserve protection against reusing an exchanged refresh token.

## 0.6.11

- Maintenance release.

## 0.6.10

- Windows packages now include the verified helpers needed for private-file access and console sign-in on Windows x64 with .NET Framework 4.8.1 or later.

## 0.6.9

- **Reload every window after updating.** A window still running the old version reports Orchestration as off, so commands its sessions run that act on other sessions are refused until it reloads.
- Agents on the bottom hub replaces Interactions. It opens a drawer with Orchestration, Skip permissions and Execution capture, which move there from the settings dialog, beside every command a session can run and whether it works right now.
- Orchestration (formerly Orchestrators) now covers every command that acts on a session, a workflow or Remote: sending, answering, starting, ending, renaming, warming, waiting, workflow steps, and posting or downloading Remote files. With it off, only listing sessions and models still works.
- `squadron-warm` lets a session turn Warm on or off for a card, as its switch on the Warm sheet does.

## 0.6.8

- Sharper onboarding screenshots, including the Tickets tab on the third slide.
- The onboarding introduction focuses on starting sessions and following their work.

## 0.6.7

- The workflow drawer opens above the ticket sheet instead of behind it.
- Ticket text reads in a clearer order: the title stands out, the ticket ID no longer matches it in size, and descriptions have more room.
- Less empty space between the board's filter row and the first group.

## 0.6.6

- Sign-out now flags a session that is waiting on a permission dialog as mid-turn.
- Escape during IME composition no longer closes the resume picker or the bottom drawer.
- Focus stays on the control you pressed when it takes over from the bottom drawer.
- A late refusal no longer undoes a newer Remote switch.
- A recycled process ID no longer blocks a new session from starting.
- The keep-awake setting describes when the hold actually ends.

## 0.6.5

- The experimental servers line shows only what is running. A Servers door on each repo's heading opens one sheet listing every worktree, with Run, Stop and port choice in place.
- The board blurs behind sheets.
- The ticket link names its tracker.
- Board tabs share one frame.

## 0.6.4

- Refreshed the extension icon: it now has no background and reads clearly on light and dark themes.
- The plan chip shows Claude's current plan names.
- Squadron follows `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `GROK_HOME` when they move a CLI's files.
- Workflows report every lane they opened, even when a later part of the step fails.
- The experimental servers line shows servers started by this window's sessions, and now works on Windows.

## 0.6.3

- Corrected folder and home-relative path labels on Windows.

## 0.6.2

- New sessions keep the effort shown in the composer when sending their first message.
- Ticket actions and dialogs open consistently from their selected ticket.
- Windows support requires .NET Framework 4.8.1.

## 0.6.1

- No user-facing changes.

## 0.6.0

- Added Windows support for Squadron CLIs and cache warming. More Windows parity improvements are planned for 0.6.x.
- Fixed remembered server ports for nested workspaces on Windows.

## 0.5.46

- Open a ticket's description and details directly from the ticket board.

## 0.5.45

- Added Windows support for Remote file transfers and MCP sign-in.
- Ticket boards load all matching tickets, and individual status columns can be collapsed.
- The chat header expands after session startup.

## 0.5.44

- Choose a Linear team for the ticket board, with tickets and filters scoped to that team.
- Ticket connection and refresh failures offer clearer recovery actions.
- Session startup waits for temporary lock-file contention to clear.

## 0.5.43

- Ticket assignee filters use the current account consistently.
- Compact filters align across Sessions and Tickets.
- The board applies the repository theme before its first paint.

## 0.5.42

- Conversation history opens faster with a reusable catalog, loads more results as you browse, and searches beyond the loaded rows.
- Pressing Enter during a history search waits for the matching results.
- Added a close button to the chat dock.
- Improved Windows path handling.

## 0.5.41

- More windows support changes, aiming to get windows support up to 50% parity with mac for 0.6.0
- Grok MCP credential updates preserve changes from other Squadron sessions.
- Codex and Grok conversation history shows the skills you invoked, as Claude's already does.

## 0.5.40

- The board shows its navigation, session heading, dock and bottom hub immediately, and fills each area in as data arrives.
- Clipped ticket columns fade at the edge.
- The dock meets the board on a clean edge, without the old shadow.
- While Tickets is open, the mascot stays on the hub and still perches on the bottom drawer.

## 0.5.39

- Chat stays visible while switching between Sessions and Tickets.
- Tickets appear in status columns with assignee, status and priority filters.
- Ending the selected session returns to the main-folder composer while preserving existing drafts.
- Sessions being ended remain visible until their processes exit.
- Full history opens reliably after resuming a conversation.

## 0.5.38

- Session status filters now use a compact dropdown with counts, a clear action and snapshot refresh.
- Local file links open correctly on Windows.

## 0.5.37

- Added Terra 6.1 to Codex model choices with its 475k usable context window.
- Improved Windows command handling and session startup reliability.

## 0.5.36

- Copying selected message text preserves the selection after using the composer.

## 0.5.35

- Improved Windows support for observing and ending sessions, with native command launchers.
- Grok replies avoid duplicate echoes when process clocks differ.
- Resume and workflow waits handle missing session evidence more reliably.

## 0.5.34

- Account usage updates from active sessions and cancels redundant background reads.
- Improved Windows path handling and process cleanup safeguards.

## 0.5.33

- Session startup avoids duplicate cleanup of leftover processes.
- Refactoring.

## 0.5.32

- Squadron commands can run from Git Bash on Windows.
- State files save more reliably on Windows when another process is reading them.

## 0.5.31

- Refactoring.

## 0.5.30

- Squadron commands now support `--help` with options, defaults, results and recovery guidance, without starting an operation.
- Workflow commands provide help for `start`, `next` and `done` separately.

## 0.5.29

- Long conversations load older messages in pages and synchronize updates incrementally.
- Conversation updates stay responsive without refreshing the whole board.
- Squadron command guidance now describes delivery, recovery and session ownership more accurately.

## 0.5.28

- Account usage refreshes hourly, even with no active conversation or the panel closed. Fresh session readings postpone the next check.
- Temporary usage readers exit after fetching, and failed checks wait an hour before retrying.
- MCP dialogs are centered across the full panel.

## 0.5.27

- More prework for windows.
- Session end and MCP dialogs align with Settings and keep their headings visible.
- End confirmations place “End just this one” after the action that also ends children.
- Session cleanup uses stronger process identity checks.

## 0.5.26

- Session end confirmations appear centered over the board.
- A session ending itself keeps its child sessions running.
- Claude conversations load correctly in directories reached through symlinks.
- Interrupted replies show a consistent divider, including when using Send now.

## 0.5.25

- Ending sessions now asks for confirmation inside Squadron.

## 0.5.24

- Some prep work for windows support.
- Drawer modes use consistent text sizes, headings and spacing.
- Older Codex model names display correctly.
- Refactoring.

## 0.5.23

- MCP Authorise, Retry and Disconnect show activity immediately and keep it
  visible until the action finishes. Repeated clicks are blocked while pending.
- MCP actions retain keyboard focus, and activity respects reduced motion.

## 0.5.22

- Session startup reports failures and cancellation more reliably, and cleans
  up children when a start does not complete.
- The Report tab highlights the survey until you open it.

## 0.5.21

- A Claude session reads busy from the moment you send it a message, instead
  of briefly reading done before the reply starts.
- Interrupt appears once the session has started working on your message.
- A new session's "Starting in …" header stays on one line when you select
  its card.
- Skill markers in the conversation fit their labels again.
- Updated the markdown parser to address security advisories.

## 0.5.20

- Keep-awake holds the Mac while a session has Warm on, so its cache is not
  lost to sleep. A new "Stay awake while Warm is on"
  switch on Keep-awake turns it off; the battery floor still applies.
- Working sessions keep the Mac awake for up to an hour without activity,
  including long commands. Keep-awake explanations are available on hover
  and keyboard focus.
- Narrow session cards keep their action buttons visible.
- A card stops showing the Warm countdown when its prompt cache expires.
- Project MCP servers appear when configured in `.mcp.json`, even without
  a global MCP configuration.
- Codex model names match the model catalog.
- Grok sessions return to idle when a turn opened by the session roster ends,
  allowing queued messages to continue.

## 0.5.19

- A spawned session's first turn, and a workflow lane's, shows as from the
  session that sent it rather than as yours.
- Squadron's agent commands name every flag for the value it takes:
  `--workflow-id`, `--file-path`, `--caller-session-id`, `--model-id`,
  `--cwd-path` and others. An old spelling says what it is now called, and a
  repeated flag is refused instead of keeping the last one.
- Remote writes each conversation to disk less often per message.
- Refactoring.

## 0.5.18

- Opus, Fable, Astra and GPT-6.1 Sol start at medium effort; Grok stays at
  high. An effort you picked for a model is kept.
- While Warm is on, a card's stamp counts down the warm time left in place of
  the last message's age.
- Remote posts one "arrived while offline" reply per conversation, even when
  its catch-up is cut off part-way.
- Interrupting an idle session reports it idle the same way from the panel and
  from another session.
- An attach to a session that has exited is refused instead of posted.
- A held report is credited to the session that sent it.
- Refactoring.

## 0.5.17

- MCP authorise and disconnect keep the selected server’s identity across repos,
  including same-named servers and stale selections.
- Refactoring.

## 0.5.16

- Workflow preflight checks skills for the brand running each step, including
  explicit lane brands and skills in parent directories within the working tree.
  File validation asks for `--brand` when the workflow needs the starting
  session's identity.
- Grok skill discovery includes Claude command files and its bundled skills,
  with each CLI's observed naming rules.
- Relative links in conversations resolve from the session's directory and
  preserve file positions.
- Refactoring.

## 0.5.15

- Refactoring.

## 0.5.14

- A new draft offers skills before a session starts. Claude, Codex and Grok
  read global skills and skills in an opened workspace, including a custom
  configuration home. A skill whose description is empty is left out.
- A caller id that contains a double quote no longer makes the window refuse
  the send.
- The mascot finds its perch again when the window returns to the front.

## 0.5.13

- The bypass word sits beside the branch on a session card. The context
  reading keeps the right end of the footer, so the two no longer run
  together as "bypass 30% / 500k". A long branch name shortens. It is not
  held to a fixed share of the strip.

## 0.5.12

- Session cards show context usage in their footer.
- Resume and history pickers show when conversations are loading.
- The inactive Warm icon matches the other card controls.
- Account usage picks up another process's reading even if a file watcher
  misses the update.
- Refactoring.

## 0.5.11

- Each session card carries its own Warm switch. The controls on the right are
  Interrupt, Warm, Copy reference, and End, and a refusal puts the switch back.
- Codex cards and the model picker show the runtime context budget. GPT-6.1
  Sol shows 475k.
- A card whose prompt cache has expired marks its age with a snowflake, in blue.
- The workflow bar measures its labels against the board. Actions that do not
  fit sit as chips above More, and they stay put when the dock opens.
- A centred sheet takes the clicks on its backdrop and the Escape key, including
  a locked login.
- Ending a session closes its dock. An ending child stays in its family.
- An effort mention filters as you type, in either case. Choosing one consumes
  what you typed.
- The composer reads image support from the model selected now, including after
  a Codex model switch.
- An open that names a brand this build cannot start is refused. Leaving the
  brand out still uses the caller's default.
- A request whose outcome is unknown exits 4 and names its id. An end request
  that cannot be written exits 5.
- Each part of a delivery keeps its own sending receipt.

## 0.5.10

- The composer rests at one line and grows to ten. Permission mode sits with
  model and effort, and Send is an arrow.
- Quoting a list from outside it wraps the touched items. A selection that
  only meets an item's edge leaves that item alone, and a numbered list keeps
  its own numbers unless the next list continues the sequence.
- A table wider than the dock scrolls inside the table, and the thread stays
  still.
- Ending a session keeps its card until the process exits. Past the deadline
  the card reads Didn't end.
- A theme chosen for a folder is stored for that folder alone. Appearance
  splits the presets into Dark and Light.
- Warm reads one cache lifetime per brand, and each tip names where that
  figure comes from. A running command no longer delays a warm ping. A wait
  for an idle session expires with the cache time it has left.
- `squadron-send` and `squadron-answer` again refuse a wake that would rebuild
  a cold cache, or a turn past 80% of its context. `--force` lifts those two
  refusals.
- A background agent that finishes names itself on the trigger row. Claude
  records only its own background tasks, and Grok records a wake a subagent
  left behind.
- The mascot draws under the accounts menu.

## 0.5.9

- Refactoring.

## 0.5.8

- Background commands finishing in Claude, Grok and Codex keep their completion
  in the conversation, with a trigger row in the dock and elapsed time measured
  from that trigger.
- Remote's `/list` shows a snapshot table of sessions.
- The experimental mascot has a porcelain body and accent-coloured wings that
  remain visible on light presets.
- `squadron-end --any` lets an agent end a session it did not start, while
  retaining the checks for busy sessions and ending itself.

## 0.5.7

- Keep-awake warns that Remote may miss messages while another window holds
  Remote, instead of saying nothing is busy.
- After an outage, Remote answers each late message once: it no longer posts
  "arrived while offline" again later, and two late direct messages each get
  their own reply.
- `squadron-send` to an idle session reports the message as sent rather than
  held.
- The Warm, Remote and Keep-awake switches always show the real setting, even
  when it changed while their sheet was shut, and a setting that fails to save
  turns its switch back.
- The usage chip in the nav bar follows a session whose turn ended after a
  permission prompt.

## 0.5.6

- An experimental mascot: a small pixel chick that sits on the workflow bar,
  flies to the card where a dialog opens, a turn finishes or a session starts,
  and keeps still in between. Turn it on under Settings → General → Mascot; it
  is off by default.
- Remote can join a Slack thread it did not start: @mention the bot inside
  any channel thread and it starts a job there, with the thread's earlier
  messages handed to the agent as a file. A later @mention tells it what is
  new. Existing Slack apps need `channels:history` and `groups:history` (and
  `users:read` for author names) and a reinstall; without them the job starts
  with your message only.

## 0.5.5

- Remote reacts to your original Slack messages as they are received, queued,
  processed and completed. Existing Slack apps need `reactions:write` and a
  reinstall to enable reactions; normal messaging keeps working without it.
- A turn's file diff compares against where that turn started, and that start
  stays after a commit, so the counts and the diff still agree. A turn with no
  saved start still opens against HEAD.

## 0.5.4

- Typing dash-space on a new line in the message box creates a bullet list.
  Empty lists and quotes hide the placeholder so it does not overlap the caret.
- Remote's setup verdict follows the last setup check and stays put when
  Remote is switched on or off.
- Remote's model picker keeps older models behind Show older models and
  remembers that choice when you go back or reload.
- Survey and the settings gear are highlighted until you open the survey.
  The Report actions stay on one row.

## 0.5.3

- Starting a job from Remote now lets you choose its model and effort after
  choosing the folder, or use that window's default. Long model lists have
  pages, and Back and Cancel keep control of the selection.
- Streaming replies hold unfinished Markdown blocks until they can render
  cleanly, keeping tables, lists and code blocks stable as text arrives.

## 0.5.2

- The selected messenger in Remote says Not configured when setup is incomplete,
  with the missing settings in its tip. Enable Remote Mode shows only its name
  and remains unavailable until setup is complete.

## 0.5.1

- Keep-awake on the bar at the bottom of the board now opens a drawer: what
  is keeping the machine awake and for how long, the Keep awake switch, a
  new switch for whether Remote alone keeps it awake, and the keeper's
  figures. Its dot follows the hold. With Remote's hold off, the Remote
  drawer warns that the machine may sleep and offers Stay awake.
- A Remote thread says when its session closed, and that a reply starts a
  new one where it ran. An End from Remote stays as it was.
- Remote's notices name the model and effort the card shows, after the
  session's name.
- The Remote sheet leads with Enable Remote Mode, above the messengers, and
  its note says what the mode is for: remote control of your agents from
  messenger apps.
- The new `squadron-heavy-runs` skill has sessions take turns on test suites,
  builds and local CI. Installed when session orchestration is on.
- Remote's Allowed accounts take a member id on its own. The workspace is a
  setting of its own at the top of the list, filled from the bot token when
  you press Check and never overwritten once you have set it; if Check finds a
  different one, the sheet offers it. An account Slack cannot use is refused
  with the reason, and one already saved is struck through with why, instead
  of being silently ignored. A full `T…:U…` entry still works.
- Remote's notices put the folder in brackets before the title, and a list
  line drops it when the heading already names it.
- The Remote sheet caps the messenger column, so the setup gets the room.
- The workflow sheet says what Workflows is for, under its title, as Warm and
  Remote already do.
- A settings menu hangs from its value at the row's right end, and a tall one
  (the model list) opens on the roomier side instead of covering its own row.

## 0.5.0

- Remote: answer this machine's sessions from your phone, through Slack. The
  Remote word on the bar at the bottom of the board opens all of it: a guide
  to making the Slack app, its two tokens, the accounts allowed to drive it, a
  check that asks Slack whether the setup works and names the step to fix, and
  the switch that turns it on. You are mentioned in a session's thread when it asks a
  question or a permission, when a top-level session finishes or fails, and
  when one stops before finishing. Reply in the thread to answer it; Deny or
  End from the buttons; `/squadron list`, `new` and `end` from Slack. Only the
  allowed accounts are heard, and a permission can be denied from the phone,
  never allowed. Remote is on in one window at a time, keeps the machine awake
  while it is on (unless keep-awake is off or the machine is on battery), and
  comes back after a reload.
- Agents can send a file into their own Remote thread with `squadron-attach`.
- Warm mode's figures (each CLI's cache lifetime, the buffer and the window)
  are settings now, and are edited where Warm mode shows them. Each lifetime's
  tip carries its CLI's note.
- A card's copper edge stays lit while its Warm switch is on. Warm turns off
  for a conversation once its 2 h window after the last real turn runs out.
- A card's time stamp counts from the last warm ping as well as from real
  activity, and a ping that never reached the model no longer counts as one.
  A failed ping says so with a cross.
- The message box formats by line: quote, list and code block take only the
  lines the caret or selection touches, and Shift+Enter on an empty quoted
  line leaves the quote.

## 0.4.8

- A session card shows a small ember along its footer while its cache is
  being warmed. The card's status and size do not change, and reduced motion
  gets a still edge instead.
- Warming no longer skips an idle session because its context is large or its
  last ping found little of the cache. It still stops when the cache has
  expired or a ping fails.
- Warm mode on the workflow sheet: the search box ends with the list, the
  policy line sits under the title, and the count of warmed sessions heads
  their column. Each cache lifetime shows its CLI's mark, with where the
  figure comes from in its tip.
- Workflow rows show Edit, Duplicate and Delete as buttons on the row when
  you hover or focus it, in place of the ⋯ menu. Pressing a row, or Enter on
  it, shows its steps.
- Bugs and Request on Settings > Report open a form for problems and
  requests.

## 0.4.6

- Warm on the bar at the bottom of the board now opens. It shows the workflow
  sheet's Warm mode: a switch per session in this window that keeps its prompt
  cache warm, the default for new sessions, and each CLI's cache lifetime.
- Settings has a Report page. Survey opens the feedback form; Bugs and Request
  are not available yet.

## 0.4.5

- Workflows are applied from the chat composer only. Pressing a workflow in
  the Workflows sheet now shows its steps, and workflows can no longer be
  pinned to the bar.
- The bar at the bottom of the board names the board-wide views: Workflows,
  Warm, Interactions and Keep-awake. The last three are not available yet.

## 0.4.4

- Workflow prompts add list and code formatting controls, plus skill and model
  mentions. Formatting has its own Undo step, preserving the text it changes.
- The empty composer's hint keeps its normal appearance inside a code block.
- Cross-session sends, answers and wait notifications share a limit of ten
  messages per rolling minute in the receiving IDE window. Stale sessions and
  context usage no longer restrict sending.

## 0.4.3

No user-facing changes.

## 0.4.2

- Settings: account usage now sits beside each account, so every CLI fits on
  one page. Show onboarding uses the standard button style.

## 0.4.1

- Experimental prompt-cache warming supports Claude, Codex and Grok. The Warm
  control offers a switch per session and a default for new conversations.
  Saved choices survive resumes.
- Short keep-alive turns run before the cache lifetime budget ends, for up to
  two hours after real activity. Warming spends tokens; cache reuse is not
  guaranteed. The control shows the next ping or why warming is held.
- Keep-alive turns appear as compact conversation rows without changing real
  activity times or completion status. Cache misses and failed pings hold
  further warming.

## 0.4.0

- Settings opens in a modal with category tabs. Manage agent accounts, choose
  model and effort together, and view release notes and extension links.

- Replies stay visible through tool calls and completion. Interrupted replies
  show a label.
- The composer adds formatting controls and fits narrow layouts. Selected
  lines become one code block. Undo restores the original formatting.
- Cache indicators and send warnings use each session's cache lifetime.
- The model picker adds Haiku 5.5 with 200k and 1M context options.

## 0.3.15

- Escape interrupts a running session when the composer has focus. Your draft
  stays intact.

## 0.3.14

- The composer and workflow prompts show bold, italic, strikethrough, code,
  lists and blockquotes while you write. Paste from Linear or Slack preserves
  supported formatting. Plain-text paste preserves literal text.
- Mentions and attachments appear as inline chips. Backspace removes a chip.
  Undo restores it. Image numbers follow message order.
- Messages show formatting while sending, queued and delivered.
- Sent messages and workflow subjects preserve leading spaces and blank lines.
- Cards retain full brightness. Waiting, stalled and failed cards pulse until
  you click the card or click, type or scroll in its conversation.
  Reduced-motion settings disable pulses.
- Selected sessions retain `done` until you interact. Conversation status
  matches card status.
- Arrow keys cycle through the mention menu.
- MCP errors and sign-in notes wrap below server rows. Status and sign-in
  controls remain readable and accessible.
- Codex commands that continue after a turn ends or stops no longer leave
  the session busy. Queued messages, Send now and Stop remain available.
- Escape interrupts only sessions with a visible conversation.

## 0.3.13

- Escape interrupts a running turn even when the message box lacks focus.

## 0.3.12

- `squadron.sound.level` replaces `squadron.sound.enabled` and
  `squadron.sound.volume`.
  Choose Off, Quiet, Normal or Loud. Normal is the default. Previous choices
  do not transfer. Select your preference again from the gear menu.
- Use @mentions for models and live sessions on the board.
- Cards show `failed` in red after a turn error. The nav counts failed cards.
  Your next turn clears the error status.

## 0.3.11

- Intel Macs can install Squadron again. macOS remains required. Windows
  support is planned.
- Account badges, Sign out and MCP rows use panel text sizes. Sign out sits
  beside the account name.
- The CLI can answer session questions.
- The workflow editor includes UI improvements.
- Narrow Resume / New controls place icons above labels, then hide labels
  when space is insufficient.

## 0.3.10

- Background commands prevent sleep for up to one hour, as running turns do.
- `squadron-step next` opens all ready lanes in one call.
- Drag workflow steps by their grips. Invalid drops restore the step without
  a leftover note. Wire previews identify the wait they would add.
- Each workflow card's structural reason appears above its model chips.

## 0.3.9

- Performance improvements.
- `squadron-rename` and the name field rename cards immediately, including
  during a turn. They send no message and add no conversation turn.
- `/rename <title>` does the same for every CLI. `/rename` opens the name
  field. Sessions must start before you can rename them.
- Workflows show grey "Paused" with Retry / Continue when a session stops
  during a step.
- Fewer background sign-in checks.
- Enable or disable execution capture from the gear menu.
- Dragged workflow cards stay in their lanes. Edits cannot make step 1 wait.
  Rejected wires identify the step a skip would bypass. Drops and model chips
  target the displayed step.
- Injected commands such as `/effort` no longer appear as skill chips.

The workflow v2 editor remains rough. Ask an AI agent to build workflows.

## 0.3.8

- Experimental execution capture supports Claude, Codex and Grok. Enable
  `squadron.checkpoints.execution.enabled` to infer file changes during tools.
  Turn captures remain the fallback when coverage is incomplete.
- Grok cards report running background commands so waits do not finish early.
- Removed the coffee cup animation to reduce resource use.

## 0.3.7

- Combined deliveries preserve each message's author. Each sending row clears
  only when its recorded turn arrives, even for identical messages.
- Grok history stays visible after context compaction.

## 0.3.6

- Sign-in codes stay masked during editing and partly visible during checks.
  Failed attempts preserve the code for retry.
- Refactoring.

## 0.3.5

- Workflow waits include sessions that are still starting. They wake after
  the required step finishes. Cancellation, coordinator loss or startup failure
  ends the wait.

## 0.3.4

- Workflow inputs show short `@skill` pills. Saved workflows and sessions
  receive the full instructions.
- Refactoring.
- Streaming file writes retain their paths and line counts in the conversation.
- New builds support Apple Silicon Macs only. Older releases remain available.

## 0.3.3

- Pasted session references show named `@session` pills in the composer and
  conversation.
- Sent skill names show green `@skill` pills in the conversation.
- Corrected spacing around adjacent file, skill and session pills.
- The Squadron workflow builder skill creates and validates reusable workflows
  without starting them.
- File links open at the specified line and column.

## 0.3.2

> Workflows v2 can report "stopped or stalled" while another session starts.
> Test sessions recovered, but recovery is not guaranteed. A future coordination
> change will address this issue.

- Added basic and advanced example workflows. The basic example uses reviews
  requested by the agent. The advanced example uses separate model lanes.
  Updates preserve your edits and deletions.

## 0.3.1

- Workflow lanes wait for required steps to finish. Cancelling a required lane
  ends the wait.

## 0.3.0

> This early release enables workflow v2 testing. Expect bugs and later fixes.

### Workflows v2

Workflow authoring, appearance and file contents will change frequently over
upcoming releases. Expect to adjust your workflows.

- Workflows run parallel session lanes. Steps wait only for required results
  from other lanes.
- Each step can select its agent, model and effort.
- If a lane's model cannot start, the lane retries once with the coordinator's
  model and reports the fallback.
- The canvas editor supports steps, cards between lanes and dependency wires.
- Workflows with invalid wiring open with errors for editing. They cannot run
  until you correct the errors.
- Existing single-session workflows continue to work.

### Onboarding

- First launch shows CLI installation, sign-in and Squadron skill status.
  You can install CLIs, set paths or sign in. A short tour follows.
- Select Show onboarding from the gear menu to reopen setup.

### Other changes

- Copied session references use `@squadron[pid][path]`. Agents can message the
  session and read its transcript. The conversation shows a named session pill.
- Machine readouts show a loading state until the first reading arrives.
- Workflows run only when selected. There is no default workflow.

## 0.2.5

- Added GPT-6.1 Sol support.

## 0.2.4

- Added Claude Sonnet 5.5 support.
