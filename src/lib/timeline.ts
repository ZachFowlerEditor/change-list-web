// Ported from timeline.rs

export const FPS_23976 = 24000 / 1001;

export interface Timeline {
  name: string;
  duration_frames: number;
  start_tc_frames: number;
  timebase: number;
  ntsc: boolean;
  width: number;
  height: number;
  clips: Clip[];
}

export interface Clip {
  id: string;
  name: string;
  scene: string;
  shot_take: string;
  source_file: string;
  master_clip_id: string;
  start: number;
  end: number;
  source_in: number;
  source_out: number;
  source_duration: number;
  enabled: boolean;
  track_index: number;
}

export function clipTimelineDuration(c: Clip): number {
  return c.end - c.start;
}

export function clipSourceDurationUsed(c: Clip): number {
  return c.source_out - c.source_in;
}

export function framesToTimecodeWithTb(totalFrames: number, timebase: number): string {
  const tb = Math.max(1, timebase);
  const negative = totalFrames < 0;
  const f = Math.abs(totalFrames);

  const ff = f % tb;
  const totalSeconds = Math.floor(f / tb);
  const ss = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mm = totalMinutes % 60;
  const hh = Math.floor(totalMinutes / 60);

  const tc = `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
  return negative ? `-${tc}` : tc;
}

export function framesToTimecode(totalFrames: number): string {
  return framesToTimecodeWithTb(totalFrames, 24);
}

export function framesToDeltaTimecode(frames: number): string {
  return framesToDeltaTimecodeWithTb(frames, 24);
}

export function framesToDeltaTimecodeWithTb(frames: number, timebase: number): string {
  if (frames === 0) return "00:00:00:00";
  const tc = framesToTimecodeWithTb(Math.abs(frames), timebase);
  return frames > 0 ? `+${tc}` : `-${tc}`;
}

export function framesToDisplayTimecode(frame: number, startTcFrames: number): string {
  return framesToTimecode(frame + startTcFrames);
}

export function framesToDisplayTimecodeWithTb(frame: number, startTcFrames: number, timebase: number): string {
  return framesToTimecodeWithTb(frame + startTcFrames, timebase);
}

export function normalizeScene(raw: string): string {
  if (!raw) return "";

  let stripped = raw;
  if (raw.startsWith("VE") && raw.length > 2 && /\d/.test(raw[2])) {
    stripped = raw.slice(2);
  } else if (raw.startsWith("V") && raw.length > 1 && /\d/.test(raw[1])) {
    stripped = raw.slice(1);
  } else if (raw.startsWith("B") && raw.length > 1 && /\d/.test(raw[1])) {
    stripped = raw.slice(1);
  }

  if (!stripped) return raw;

  // Strip trailing uppercase setup letter if preceded by a digit
  const last = stripped[stripped.length - 1];
  const secondLast = stripped[stripped.length - 2];
  let scenePart = stripped;
  if (last >= "A" && last <= "Z" && stripped.length > 1 && secondLast >= "0" && secondLast <= "9") {
    scenePart = stripped.slice(0, stripped.length - 1);
  }

  const normalized = scenePart.replace(/^0+/, "");
  return normalized || "0";
}

export function sceneFromName(name: string): string {
  const dashPos = name.indexOf("-");
  if (dashPos < 0) return "";
  const prefix = name.slice(0, dashPos);
  return normalizeScene(prefix);
}

/** Premiere Pro ticks per second (254016000000) */
const TICKS_PER_SEC = 254016000000;

export function ticksPerFrame(timebase: number, ntsc: boolean): number {
  if (ntsc) {
    return Math.round(TICKS_PER_SEC * 1001 / (timebase * 1000));
  }
  return Math.round(TICKS_PER_SEC / timebase);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
