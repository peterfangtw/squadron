import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openPanel, openSettings, stateMessage, groupView, cardView, switchRow } from '../harness';

/**
 * The notification cues. jsdom has no Web Audio, which is the same shape as a
 * host that denies it, so the scenarios here supply their own `AudioContext`
 * and read back what the panel asked it to play. Frequencies and rhythm are
 * the assertion: they are what tells the two cues apart by ear, so they are
 * what a change to either has to walk past.
 */

/** One tone the panel scheduled: its pitch, when it starts, its peak gain. */
type Played = { hz: number; at: number; gain: number };

/**
 * A recording stand-in for `AudioContext`, installed on the panel's window.
 * Returns the array it records into — empty until a cue is delivered.
 *
 * `connect` returns its argument because the source chains
 * (`osc.connect(gain).connect(destination)`), and `currentTime` stays 0 so a
 * scheduled time reads as an offset from the cue's start.
 */
function captureAudio(p: ReturnType<typeof openPanel>): Played[] {
  const played: Played[] = [];
  class FakeContext {
    currentTime = 0;
    destination = {};
    resume(): void {}
    close(): void {}
    createOscillator(): unknown {
      const tone: Played = { hz: 0, at: 0, gain: 0 };
      played.push(tone);
      return {
        type: '',
        frequency: {
          set value(hz: number) {
            tone.hz = hz;
          }
        },
        connect: (next: unknown) => next,
        start: (at: number) => {
          tone.at = at;
        },
        stop: () => {}
      };
    }
    createGain(): unknown {
      // The gain node belongs to the oscillator created just before it.
      const tone = played[played.length - 1];
      return {
        gain: {
          setValueAtTime: () => {},
          linearRampToValueAtTime: (v: number) => {
            if (tone) tone.gain = v;
          },
          exponentialRampToValueAtTime: () => {}
        },
        connect: (next: unknown) => next
      };
    }
  }
  (p.window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
  return played;
}

/** Start times relative to the first tone, rounded past floating-point noise. */
const rhythm = (played: Played[]): number[] => {
  const first = played[0]?.at ?? 0;
  return played.map((t) => Math.round((t.at - first) * 1000));
};

describe('the notification cues', () => {
  // A level stated, because the fixture's default is `off` and `playCue` now
  // refuses at that level rather than leaving the silence to the host's gate.
  const open = (t: Parameters<typeof openPanel>[0]) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 5 })] })], { soundLevel: 'normal' })
    );
    return p;
  };

  it('plays done as a rising fifth, one note into the next', (t) => {
    const p = open(t);
    const played = captureAudio(p);
    p.push({ type: 'sound', cue: 'done' });
    assert.deepEqual(
      played.map((x) => x.hz),
      [880, 1319]
    );
    assert.deepEqual(rhythm(played), [0, 80]);
  });

  it('plays blocked as two taps on one note, with a gap', (t) => {
    const p = open(t);
    const played = captureAudio(p);
    p.push({ type: 'sound', cue: 'blocked' });
    assert.deepEqual(
      played.map((x) => x.hz),
      [587, 587]
    );
    assert.deepEqual(rhythm(played), [0, 180]);
  });

  // Not a detail: blocked is the cue that has to arrive over whatever else is
  // making noise, and done is the one heard a hundred times a day.
  it('sounds blocked louder than done', (t) => {
    const p = open(t);
    const played = captureAudio(p);
    p.push({ type: 'sound', cue: 'done' });
    p.push({ type: 'sound', cue: 'blocked' });
    const done = played[0]?.gain ?? 0;
    const blocked = played[2]?.gain ?? 0;
    assert.ok(blocked > done, `blocked ${blocked} is not louder than done ${done}`);
  });

  // A cue is a courtesy. A panel in a host that denies Web Audio still has to
  // repaint, so a missing API cannot be allowed to throw out of the handler.
  it('stays quiet and standing where there is no audio to be had', (t) => {
    const p = open(t);
    delete (p.window as unknown as { AudioContext?: unknown }).AudioContext;
    p.push({ type: 'sound', cue: 'done' });
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 5, name: 'after' })] })]));
    assert.ok(p.window.document.querySelector('.card'), 'the board stopped repainting');
  });
});

describe('the sound level', () => {
  const soundRow = (p: ReturnType<typeof openPanel>, over: Partial<StateMessage> = {}) => {
    p.push(stateMessage([groupView()], over));
    return switchRow(openSettings(p), 'Sound');
  };

  /** Pick a level off the row's open flyout, by the word on it. */
  const pick = (p: ReturnType<typeof openPanel>, label: string): void => {
    const item = [...p.window.document.querySelectorAll<HTMLElement>('.fmenu.fly .mitem')].find(
      (row) => row.querySelector('.nm')?.textContent === label
    );
    assert.ok(item, `the row offers no ${label}`);
    item.click();
  };

  /** The gain of the first tone of one `done`, at the level in force. */
  const loudness = (p: ReturnType<typeof openPanel>, level: SoundLevel): number => {
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 5 })] })], { soundLevel: level }));
    const played = captureAudio(p);
    p.push({ type: 'sound', cue: 'done' });
    return played[0]?.gain ?? 0;
  };

  it('offers off first, then the three loudnesses', (t) => {
    const p = openPanel(t);
    soundRow(p).click();
    assert.deepEqual(
      [...p.window.document.querySelectorAll<HTMLElement>('.fmenu.fly .mitem')].map(
        (row) => row.querySelector('.nm')?.textContent
      ),
      ['Off', 'Quiet', 'Normal', 'Loud']
    );
  });

  it('scales the cues by the level in force', (t) => {
    const p = openPanel(t);
    const quiet = loudness(p, 'quiet');
    const normal = loudness(p, 'normal');
    const loud = loudness(p, 'loud');
    assert.ok(quiet < normal, `quiet ${quiet} is not under normal ${normal}`);
    assert.ok(loud > normal, `loud ${loud} is not over normal ${normal}`);
  });

  // The pair moves together or the row is picking which cue matters, which is
  // not a decision a loudness is allowed to make.
  it('keeps blocked over done at every loudness', (t) => {
    for (const level of ['quiet', 'normal', 'loud'] as const) {
      const p = openPanel(t);
      p.push(
        stateMessage([groupView({ sessions: [cardView({ pid: 5 })] })], { soundLevel: level })
      );
      const played = captureAudio(p);
      p.push({ type: 'sound', cue: 'done' });
      p.push({ type: 'sound', cue: 'blocked' });
      const done = played[0]?.gain ?? 0;
      const blocked = played[2]?.gain ?? 0;
      assert.ok(blocked > done, `at ${level}, blocked ${blocked} is not over done ${done}`);
    }
  });

  it('reads the level in force', (t) => {
    const row = soundRow(openPanel(t), { soundLevel: 'loud' });
    assert.equal(row.querySelector('.val')?.firstChild?.textContent, 'Loud');
  });

  it('reads off as off, not as a loudness', (t) => {
    const row = soundRow(openPanel(t), { soundLevel: 'off' });
    assert.equal(row.querySelector('.val')?.firstChild?.textContent, 'Off');
  });

  it('posts a picked loudness', (t) => {
    const p = openPanel(t);
    const row = soundRow(p);
    row.click();
    pick(p, 'Quiet');
    assert.deepEqual(p.posted.at(-1), { type: 'setSound', level: 'quiet' });
    assert.equal(row.querySelector('.val')?.firstChild?.textContent, 'Quiet');
  });

  it('posts off as a level of its own', (t) => {
    const p = openPanel(t);
    const row = soundRow(p, { soundLevel: 'normal' });
    row.click();
    pick(p, 'Off');
    assert.deepEqual(p.posted.at(-1), { type: 'setSound', level: 'off' });
    assert.equal(row.querySelector('.val')?.firstChild?.textContent, 'Off');
  });

  // Picking a loudness you cannot hear is picking blind: the row sounds the cue
  // it just set, at the level it just set. The state here still says `off`, so
  // this covers the preview reading the pick rather than the level it has.
  it('sounds the pick, at the picked level', (t) => {
    const p = openPanel(t);
    const row = soundRow(p);
    const played = captureAudio(p);
    row.click();
    pick(p, 'Loud');
    assert.deepEqual(
      played.map((x) => x.hz),
      [880, 1319],
      'the pick sounded no done cue'
    );
    // Equal to `loud` and not merely over `quiet`: a preview stuck at the
    // default would clear that bar and this would pass through the bug.
    assert.equal(played[0]?.gain, loudness(openPanel(t), 'loud'));
  });

  it('sounds nothing when off is the pick', (t) => {
    const p = openPanel(t);
    const row = soundRow(p, { soundLevel: 'loud' });
    const played = captureAudio(p);
    row.click();
    pick(p, 'Off');
    assert.deepEqual(played, []);
  });
});
