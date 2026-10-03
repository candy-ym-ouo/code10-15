import { midiToFrequency, type IntervalQuestionPayload, type RhythmQuestionPayload } from "@practice/contracts";

let sharedContext: AudioContext | null = null;
let activePlayback: { stop: () => void } | null = null;

function trackPlayback<T extends { stop: () => void }>(handle: T): T {
  activePlayback?.stop();
  activePlayback = { stop: () => handle.stop() };
  return {
    ...handle,
    stop: () => {
      if (activePlayback) activePlayback = null;
      handle.stop();
    },
  };
}

function getContext(): AudioContext {
  if (!sharedContext || sharedContext.state === "closed") {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedContext = new Ctor();
  }
  if (sharedContext.state === "suspended") void sharedContext.resume();
  return sharedContext;
}

interface ScheduledVoice {
  oscillator: OscillatorNode;
}

function voice(
  ctx: AudioContext,
  nodes: Set<ScheduledVoice>,
  startAt: number,
  duration: number,
  frequency: number,
  type: OscillatorType,
  peak: number,
): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.05);
  const handle = { oscillator };
  nodes.add(handle);
  oscillator.onended = () => nodes.delete(handle);
}

function stopAll(nodes: Set<ScheduledVoice>): void {
  for (const node of nodes) {
    try {
      node.oscillator.stop();
    } catch {
      // 已结束的节点忽略
    }
  }
  nodes.clear();
}

/** 播放音程题。stop 会立即静音但不关闭共享 AudioContext。 */
export function playInterval(payload: IntervalQuestionPayload): { stop: () => void } {
  const ctx = getContext();
  const nodes = new Set<ScheduledVoice>();
  const now = ctx.currentTime + 0.06;
  const noteDuration = 0.9;
  const rootFrequency = midiToFrequency(payload.rootMidi);
  const targetFrequency = midiToFrequency(payload.rootMidi + payload.answerSemitones * (payload.direction === -1 ? -1 : 1));
  if (payload.direction === 0) {
    voice(ctx, nodes, now, noteDuration, rootFrequency, "sine", 0.22);
    voice(ctx, nodes, now, noteDuration, targetFrequency, "sine", 0.22);
  } else {
    voice(ctx, nodes, now, noteDuration, rootFrequency, "sine", 0.22);
    voice(ctx, nodes, now + noteDuration + 0.18, noteDuration, targetFrequency, "sine", 0.22);
  }
  return trackPlayback({ stop: () => stopAll(nodes) });
}

/**
 * 播放节奏题：预备拍 + 节拍器 + 音符（休止符静默）。
 * 返回题面起点（预备拍之后）的时间戳，供用户点击时计算相对毫秒。
 */
export function playRhythm(
  payload: RhythmQuestionPayload,
  onEnd?: () => void,
): { musicStartedAt: number; stop: () => void } {
  const ctx = getContext();
  const nodes = new Set<ScheduledVoice>();
  const audioStart = ctx.currentTime + 0.12;
  const beatSeconds = 60 / payload.bpm;
  const countdownBars = 1;

  // 一小节预备拍
  for (let beat = 0; beat < payload.beatsPerBar; beat += 1) {
    voice(ctx, nodes, audioStart + beat * beatSeconds, 0.07, beat === 0 ? 1320 : 920, "square", beat === 0 ? 0.16 : 0.09);
  }

  const musicOffset = countdownBars * payload.beatsPerBar * beatSeconds;
  const musicStart = audioStart + musicOffset;
  payload.bars.forEach((bar, barIndex) => {
    for (const event of bar) {
      const startBeat = barIndex * payload.beatsPerBar + event.startBeat;
      const at = musicStart + startBeat * beatSeconds;
      voice(ctx, nodes, at, 0.07, barIndex === 0 && event.startBeat === 0 ? 1320 : 920, "square", 0.09);
      if (!event.isRest) {
        voice(ctx, nodes, at, Math.max(0.09, event.durationBeats * beatSeconds * 0.9), 320, "sine", 0.16);
      }
    }
  });

  const totalBeats = (countdownBars + payload.barCount) * payload.beatsPerBar;
  const musicStartedAt = performance.now() + 120 + musicOffset * 1000;
  const timeout = window.setTimeout(() => {
    nodes.clear();
    activePlayback = null;
    onEnd?.();
  }, 120 + totalBeats * beatSeconds * 1000);

  return trackPlayback({
    musicStartedAt,
    stop: () => {
      window.clearTimeout(timeout);
      stopAll(nodes);
    },
  });
}
