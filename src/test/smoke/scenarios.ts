/** Names the barrel may load, in registration order. Unknown or repeated names are refused. */
export function scenarioSelection(raw: unknown = scenarios): readonly string[] {
  if (!Array.isArray(raw)) throw new Error('unknown smoke scenario selection');
  const seen = new Set<string>();
  for (const name of raw) {
    if (typeof name !== 'string' || seen.has(name) || !scenarios.includes(name))
      throw new Error('unknown smoke scenario selection');
    seen.add(name);
  }
  return scenarios.filter((name) => seen.has(name));
}

export const scenarios: readonly string[] = [
  'onboarding.smoke',
  'models.smoke',
  'send_burst.smoke',
  'request_origin.smoke',
  'panel.smoke',
  'theme_startup.smoke',
  'board_filters.smoke',
  'conversation_catalog.smoke',
  'bottom_hub.smoke',
  'nav_loading.smoke',
  'warm.smoke',
  'awake.smoke',
  'agents.smoke',
  'mascot.smoke',
  'warm_card.smoke',
  'dropdown.smoke',
  'editor_foot.smoke',
  'footer_mode.smoke',
  'editor_canvas.smoke',
  'diff.smoke',
  'asks.smoke',
  'thread_table.smoke',
  'session.smoke',
  'composer_editor.smoke',
  'routines.smoke',
  'session_end.smoke',
  'thread_acquisition.smoke',
  'thread_refresh.smoke',
  'transcript_pagination.smoke',
  'execution.smoke',
  'first_send.smoke',
  'failed.smoke',
  'grok.smoke',
  'codex.smoke',
  'tickets.smoke',
  'github_projects.smoke',
  'ticket_pills.smoke',
  'servers.smoke',
  'monorepo.smoke',
  'notices.smoke',
  'accounts.smoke',
  'mcp.smoke',
  'workflow_repair.smoke',
  'workflow_wait.smoke',
  'wait_deadline.smoke',
  'workflow_examples.smoke',
  'folderless.smoke'
];
