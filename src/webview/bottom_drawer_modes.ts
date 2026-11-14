import * as routines from './routines_mode';
import * as awakeRows from '../ui/awake_rows';
import * as agentsSheet from './agents_sheet';
import * as awakeSheet from './awake_sheet';
import * as remoteSheet from './remote_sheet';
import * as warmMenu from './warm_menu';
import * as workflows from './workflows_mode';
import type { TipRow } from './tip';

export type HubWord = {
  count?: number;
  tone?: string;
  tip?: string;
  rows?: TipRow[];
  label?: string;
};

type ModeSpec = {
  id: string;
  barClass: string;
  title: string;
  focusWord: string | undefined;
} & (
  | {
      available: true;
      columns: boolean;
      note: () => string;
      paint: () => void;
      repaint: (active: boolean, pushed: boolean) => void;
      bar: () => HubWord;
      badge?: 'count' | 'dot';
      beat: boolean;
      closed?: () => void;
      empty?: () => boolean;
      emptyWord?: () => HTMLElement;
    }
  | { available: false }
);

// The sheet and its content import this registry too; imported values are read
// only when a callback runs, after the whole cycle has initialized (H56).
const MODES = [
  {
    id: 'agents',
    barClass: 'hpill agents-tab',
    title: 'Agents',
    focusWord: '.agents-tab',
    available: true,
    columns: true,
    note: () => 'What sessions may do to each other, and how new ones start.',
    paint: () => agentsSheet.paintAgentsSheet(),
    repaint: (active: boolean) => {
      if (active) agentsSheet.paintAgentsSheet();
    },
    bar: () => agentsSheet.agentsBar(),
    badge: 'dot',
    beat: false
  },
  {
    id: 'workflows',
    barClass: 'wmore',
    title: 'Workflows',
    focusWord: undefined,
    available: true,
    columns: false,
    note: () =>
      'Compose a workflow so an agent takes on more complex work, and follows the steps you wrote.',
    paint: () => workflows.paintWorkflows(),
    repaint: (active: boolean) => {
      workflows.settleDraft();
      if (active) workflows.paintWorkflows();
    },
    closed: () => workflows.closed(),
    empty: () => workflows.empty(),
    emptyWord: () => workflows.emptyWord(),
    bar: () => ({ tip: 'All workflows', label: 'All workflows' }),
    beat: false
  },
  {
    id: 'routines',
    barClass: 'hpill routines-tab',
    title: 'Routines',
    focusWord: '.routines-tab',
    available: true,
    columns: true,
    note: () => 'Reminders for this project. Every run starts with your click.',
    paint: () => routines.paint(),
    repaint: (active: boolean) => routines.repaint(active),
    closed: () => routines.closed(),
    bar: () => routines.bar(),
    badge: 'count',
    beat: false
  },
  {
    id: 'remote',
    barClass: 'hpill remote-tab',
    title: 'Remote',
    focusWord: '.remote-tab',
    available: true,
    columns: true,
    note: () => 'Remote control your agents from messenger apps.',
    paint: () => remoteSheet.paintRemoteSheet(),
    repaint: (active: boolean, pushed: boolean) => remoteSheet.repaintRemote(active, pushed),
    bar: () => remoteSheet.remoteBar(),
    badge: 'dot',
    beat: false
  },
  {
    id: 'warm',
    barClass: 'hpill warm-tab',
    title: 'Warm',
    focusWord: '.warm-tab',
    available: true,
    columns: true,
    note: () => warmMenu.warmNote(),
    paint: () => warmMenu.paintWarmSheet(),
    repaint: (active: boolean) => {
      if (active) warmMenu.paintWarmSheet();
    },
    bar: () => warmMenu.warmBar(),
    badge: 'count',
    beat: true
  },
  {
    id: 'awake',
    barClass: 'hpill awake-tab',
    title: 'Keep-awake',
    focusWord: '.awake-tab',
    available: true,
    columns: true,
    note: () => awakeRows.AWAKE_NOTE,
    paint: () => awakeSheet.paintAwakeSheet(),
    repaint: (active: boolean) => {
      if (active) awakeSheet.repaintAwake();
    },
    bar: () => awakeSheet.awakeBar(),
    badge: 'dot',
    beat: true
  }
] as const satisfies readonly ModeSpec[];

export type DrawerModeId = (typeof MODES)[number]['id'];
export type DrawerMode = ModeSpec & { id: DrawerModeId };

export function modes(): readonly DrawerMode[] {
  return MODES;
}

export function modeFor(id: DrawerModeId): DrawerMode {
  const mode = MODES.find((entry) => entry.id === id);
  if (!mode) throw new Error(`Unknown drawer mode: ${id}`);
  return mode;
}
