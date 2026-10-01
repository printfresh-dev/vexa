/** Active-phase aloneness derived from the remote-audio signal. */
import type { AlonenessSource } from './ports.js';

export const DEFAULT_ALONE_SILENCE_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_ALONENESS_POLL_MS = 1_500;
export const DEFAULT_MEET_ROSTER_EMPTY_DEBOUNCE_MS = 5_000;
/** Presence floor for a DELIVERED remote frame — deliberately 0 (arrival is the signal).
 *
 *  Capture is the single silence oracle: the page emits a frame only when its PEAK sample exceeds
 *  its own gate (`mixed-audio.ts` / `gmeet-capture.ts`, 0.005), and the activity tap sits on the
 *  Node side of that gate (`capture-bridge.ts:289,298`). So every frame that reaches this seam has
 *  ALREADY proven it carries audio — and was sent to STT and transcribed on that basis.
 *
 *  Re-testing such a frame with RMS (always ≤ peak; for speech 3–5× lower) against the SAME 0.005
 *  could only ever REJECT audio the capture gate accepted — never admit anything it refused. It was
 *  a pure false-negative generator: a participant speaking quietly was transcribed while counting as
 *  silence toward `left_alone`, so the bot could leave a meeting it could hear. #850 measured 23.3%
 *  of frames in one real fixture sitting in exactly that peak-passes/RMS-fails band.
 *
 *  A cost decision ("don't pay Whisper for near-silence") is not a presence decision. Only a frame
 *  carrying no energy at all is silence here; anything the capture gate delivered is someone. */
export const REMOTE_AUDIO_ENERGY_FLOOR = 0;

export interface RemoteAudioActivitySnapshot {
  available: boolean;
  lastRemoteAudioAt?: number;
}

export interface RemoteAudioActivitySource {
  snapshot(): RemoteAudioActivitySnapshot;
}

export interface RemoteAudioActivityTap extends RemoteAudioActivitySource {
  /** Capture is attached and can distinguish silence from a missing signal. */
  ready(): void;
  /** Record one REMOTE frame's RMS energy. Local bot speech never enters this seam. */
  observeRemoteEnergy(energy: number): void;
  /** Capture stopped or failed; aloneness must fail closed until it is ready again. */
  unavailable(): void;
}

export type AlonenessVerdict = 'alone' | 'not-alone' | 'unavailable';

/** One deployment-selectable rule. Later adapters override earlier ones while available. */
export interface AlonenessAdapter {
  readonly name: string;
  evaluate(snapshot: RemoteAudioActivitySnapshot, now: number, windowMs: number): AlonenessVerdict;
}

export interface TimerScheduler {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export function createRemoteAudioActivityTap(options: {
  now?: () => number;
  energyFloor?: number;
} = {}): RemoteAudioActivityTap {
  const now = options.now ?? Date.now;
  const energyFloor = options.energyFloor ?? REMOTE_AUDIO_ENERGY_FLOOR;
  let state: RemoteAudioActivitySnapshot = { available: false };

  return {
    ready(): void {
      state = { available: true, lastRemoteAudioAt: now() };
    },
    observeRemoteEnergy(energy: number): void {
      // Digital silence (or a nonsense reading) is not presence; every other delivered frame is.
      if (!state.available || !Number.isFinite(energy) || energy <= 0 || energy < energyFloor) return;
      state = { available: true, lastRemoteAudioAt: now() };
    },
    unavailable(): void {
      state = { available: false };
    },
    snapshot(): RemoteAudioActivitySnapshot {
      return { ...state };
    },
  };
}

export interface RosterPresenceSnapshot {
  hasSeenRemoteParticipant: boolean;
  remoteParticipantCount?: number;
  selfPresent?: boolean;
  emptySince?: number;
}

export interface RosterPresenceSource {
  snapshot(): RosterPresenceSnapshot;
}

export interface RosterPresenceTap extends RosterPresenceSource {
  observe(remoteParticipantCount: number, selfPresent: boolean): void;
  unavailable(): void;
}

export function createRosterPresenceTap(options: {
  now?: () => number;
} = {}): RosterPresenceTap {
  const now = options.now ?? Date.now;
  let state: RosterPresenceSnapshot = { hasSeenRemoteParticipant: false };

  return {
    observe(remoteParticipantCount, selfPresent): void {
      if (!Number.isInteger(remoteParticipantCount)
        || remoteParticipantCount < 0
        || typeof selfPresent !== 'boolean') {
        state = { hasSeenRemoteParticipant: state.hasSeenRemoteParticipant };
        return;
      }
      const hasSeenRemoteParticipant =
        state.hasSeenRemoteParticipant || remoteParticipantCount > 0;
      // Meet never lists the signed-in bot's own tile (live logs 2026-10-01), so emptiness is
      // judged on remote participants alone; selfPresent is kept for diagnostics only.
      const emptySince = remoteParticipantCount === 0
        ? state.remoteParticipantCount === 0 && state.emptySince !== undefined
          ? state.emptySince
          : now()
        : undefined;
      state = { hasSeenRemoteParticipant, remoteParticipantCount, selfPresent, emptySince };
    },
    unavailable(): void {
      state = { hasSeenRemoteParticipant: state.hasSeenRemoteParticipant };
    },
    snapshot(): RosterPresenceSnapshot {
      return { ...state };
    },
  };
}

/** Remote audio must also have been silent this long before an empty roster ends the meeting. */
export const DEFAULT_MEET_ROSTER_SILENCE_CONFIRM_MS = 20_000;

/**
 * Leaves an emptied Google Meet early: remote participants were seen this session, the roster has
 * listed none for the debounce, and no remote audio arrived for the confirm window (so a broken
 * scan cannot end a meeting people are talking in). It never returns 'not-alone': the roster only
 * shortens the silence rule's wait, it never extends it.
 */
export function createMeetRosterAlonenessAdapter(
  roster: RosterPresenceSource,
  debounceMs = DEFAULT_MEET_ROSTER_EMPTY_DEBOUNCE_MS,
  silenceConfirmMs = DEFAULT_MEET_ROSTER_SILENCE_CONFIRM_MS,
): AlonenessAdapter {
  return {
    name: 'meet-roster',
    evaluate(activity, now): AlonenessVerdict {
      const snapshot = roster.snapshot();
      if (
        !snapshot.hasSeenRemoteParticipant
        || snapshot.remoteParticipantCount !== 0
        || snapshot.emptySince === undefined
        || now - snapshot.emptySince < debounceMs
        || !activity.available
        || activity.lastRemoteAudioAt === undefined
        || now - activity.lastRemoteAudioAt < silenceConfirmMs
      ) return 'unavailable';
      return 'alone';
    },
  };
}

export const silenceAlonenessAdapter: AlonenessAdapter = {
  name: 'silence',
  evaluate(snapshot, now, windowMs): AlonenessVerdict {
    if (!snapshot.available || snapshot.lastRemoteAudioAt === undefined) return 'unavailable';
    return now - snapshot.lastRemoteAudioAt >= windowMs ? 'alone' : 'not-alone';
  },
};

export function resolveAloneSilenceWindowMs(
  explicitEveryoneLeftTimeout: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(`[bot] ${message}`),
): number {
  if (typeof explicitEveryoneLeftTimeout === 'number'
    && Number.isFinite(explicitEveryoneLeftTimeout)
    && explicitEveryoneLeftTimeout > 0) {
    return explicitEveryoneLeftTimeout;
  }
  const raw = env.BOT_ALONE_SILENCE_WINDOW_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
    warn(`BOT_ALONE_SILENCE_WINDOW_MS=${JSON.stringify(raw)} is invalid; using the 10-minute default`);
  }
  return DEFAULT_ALONE_SILENCE_WINDOW_MS;
}
export function resolveAloneNotBeforeMs(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(`[bot] ${message}`),
): number | undefined {
  const raw = env.BOT_ALONE_NOT_BEFORE_AT;
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Date.parse(raw);
  if (Number.isFinite(value)) return value;
  warn(`BOT_ALONE_NOT_BEFORE_AT=${JSON.stringify(raw)} is invalid; allowing the ordinary silence window`);
  return undefined;
}


export function createSilenceAlonenessSource(options: {
  activity: RemoteAudioActivitySource;
  windowMs: number;
  notBeforeMs?: number;
  adapters?: readonly AlonenessAdapter[];
  now?: () => number;
  pollMs?: number;
  setInterval?: TimerScheduler['setInterval'];
  clearInterval?: TimerScheduler['clearInterval'];
  log?: (message: string) => void;
}): AlonenessSource {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? DEFAULT_ALONENESS_POLL_MS;
  const adapters = options.adapters ?? [silenceAlonenessAdapter];
  const setIntervalFn = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const clearIntervalFn = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const log = options.log ?? ((message) => console.log(`[bot] ${message}`));

  return {
    onAlone(callback): () => void {
      let handle: unknown;
      let stopped = false;
      let fired = false;

      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        if (handle !== undefined) clearIntervalFn(handle);
      };
      const tick = (): void => {
        if (stopped || fired || adapters.length === 0) return;
        const at = now();
        const snapshot = options.activity.snapshot();
        let decision: { adapter: AlonenessAdapter; verdict: AlonenessVerdict } | undefined;
        for (let index = adapters.length - 1; index >= 0; index--) {
          const adapter = adapters[index];
          const verdict = adapter.evaluate(snapshot, at, options.windowMs);
          if (verdict !== 'unavailable') {
            decision = { adapter, verdict };
            break;
          }
        }
        if (!decision || decision.verdict !== 'alone') return;
        if (decision.adapter.name === 'silence'
          && options.notBeforeMs !== undefined
          && at < options.notBeforeMs) return;
        fired = true;
        stop();
        const detail = decision.adapter.name === 'silence'
          ? ` (last_remote_audio_at=${snapshot.lastRemoteAudioAt}, window_ms=${options.windowMs}, not_before_ms=${options.notBeforeMs ?? 'none'})`
          : '';
        log(`aloneness: ${decision.adapter.name} verdict${detail}`);
        callback();
      };

      handle = setIntervalFn(tick, pollMs);
      tick();
      return stop;
    },
  };
}
