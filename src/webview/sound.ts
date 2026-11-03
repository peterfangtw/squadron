/**
 * The panel's two notification cues, synthesised rather than played.
 *
 * No audio file anywhere: a few sine tones out of the Web Audio API is less
 * than the base64 of the smallest WAV worth shipping, and it needs nothing
 * from the CSP — `media-src` gates `<audio src>`, not an oscillator. It is
 * also the only version of this that stays inside the no-runtime-dependency
 * rule without a binary blob in the repo.
 *
 * The two must differ in rhythm and not merely in pitch, because the speaker
 * this is heard on is a laptop's and the room it is heard in has other noise
 * in it: `done` is one note that rises, `blocked` is two flat taps. That is
 * distinguishable without having learnt either.
 */

/** One tone: frequency in Hz, when it starts and how long it lasts, seconds. */
type Tone = { hz: number; at: number; for: number };

/**
 * `done` — a rising perfect fifth, A5 to E6. It resolves, so it reads as
 * finished, and it is the cue that fires often, so it is the quiet one.
 */
const DONE: Tone[] = [
  { hz: 880, at: 0, for: 0.09 },
  { hz: 1319, at: 0.08, for: 0.14 }
];

/**
 * `blocked` — the same note twice, D5, with a gap. Two knocks read as somebody
 * asking, which is what this is. A falling interval was the other candidate
 * and says "error": a session waiting on a permission prompt has not failed.
 */
const BLOCKED: Tone[] = [
  { hz: 587, at: 0, for: 0.08 },
  { hz: 587, at: 0.18, for: 0.08 }
];

/** Peak gain per cue. `blocked` is the louder because it has to interrupt. */
const GAIN: Record<SoundCue, number> = { done: 0.06, blocked: 0.09 };

/**
 * What the reader's pick multiplies the pair above by — both cues, so the ratio
 * between them survives every step.
 *
 * Roughly ±8dB either side of `normal`, which is about as far as this can go:
 * loud puts `blocked` at 0.225 peak, still a fifth of the headroom, and quiet
 * has to stay over the noise floor of a laptop speaker to be a cue at all
 * rather than a thing people wonder whether they heard.
 */
const VOLUME: Record<SoundVolume, number> = { quiet: 0.4, normal: 1, loud: 2.5 };

/**
 * Play one. Silent rather than throwing wherever there is no audio to be had —
 * a headless jsdom run, a host that denies the API — because a cue is a
 * courtesy and nothing above it should have to care whether it landed.
 *
 * `off` is one more way to have none, checked here so the settings row's own
 * preview gets it free.
 */
export function playCue(cue: SoundCue, level: SoundLevel): void {
  if (level === 'off') return;
  const Ctor = window.AudioContext;
  if (!Ctor) return;
  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch {
    return;
  }
  // A context created before the reader has ever clicked the webview starts
  // suspended under the autoplay policy. Resuming is a no-op once they have,
  // and this cue is lost rather than queued if they have not — which is right:
  // nobody is at the panel to hear it anyway.
  void ctx.resume?.();

  // 10ms in, so the first envelope ramp is still in the future when it is
  // scheduled. Ramping from a time already past is what clicks.
  const start = ctx.currentTime + 0.01;
  for (const tone of cue === 'done' ? DONE : BLOCKED) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = tone.hz;
    const on = start + tone.at;
    // Attack, then an exponential tail: a square-edged sine is heard as a
    // click at both ends, and exponential is how a struck thing actually dies.
    gain.gain.setValueAtTime(0, on);
    gain.gain.linearRampToValueAtTime(GAIN[cue] * VOLUME[level], on + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, on + tone.for);
    osc.connect(gain).connect(ctx.destination);
    osc.start(on);
    osc.stop(on + tone.for + 0.02);
  }
  // Every cue gets its own context and every context holds an audio thread, so
  // the one that just played has to be let go of. Comfortably past the longest
  // cue, since closing early truncates it.
  window.setTimeout(() => void ctx.close(), 2000);
}
