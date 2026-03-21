// Ported from change_detector.rs

import type { Clip, Timeline } from "./timeline";
import { normalizeScene, sceneFromName, framesToDeltaTimecode } from "./timeline";

export type Confidence = "High" | "Medium" | "Low";

export function confidenceScore(c: Confidence): number {
  return c === "High" ? 95 : c === "Medium" ? 75 : 45;
}

export function confidenceLabel(c: Confidence): string {
  return c;
}

export type ChangeType =
  | "RemovedFromHead"
  | "RemovedFromTail"
  | "RemovedFromMiddle"
  | "AddedToHead"
  | "AddedToTail"
  | "AddedInMiddle"
  | "ShotRemoved"
  | "ShotAdded"
  | "ShotReplaced"
  | "EditPointShifted"
  | "CameraSwap";

export function changeTypeDescription(ct: ChangeType, frames: number): string {
  const f = Math.abs(frames);
  switch (ct) {
    case "RemovedFromHead": return `Removed ${f}fr from head`;
    case "RemovedFromTail": return `Removed ${f}fr from tail`;
    case "RemovedFromMiddle": return `Removed ${f}fr from middle (jump cut)`;
    case "AddedToHead": return `Added ${f}fr to head`;
    case "AddedToTail": return `Added ${f}fr to tail`;
    case "AddedInMiddle": return `Added ${f}fr in middle`;
    case "ShotRemoved": return "Shot removed";
    case "ShotAdded": return "Shot added";
    case "ShotReplaced": return "Shot replaced";
    case "EditPointShifted": return `Edit point shifted by ${f}fr`;
    case "CameraSwap": return "Camera swap (same take, different angle)";
  }
}

export interface Change {
  scene: string;
  timecode_frames: number;
  description: string;
  delta_frames: number;
  confidence: Confidence;
  change_type: ChangeType;
  clip_name: string;
}

export interface ChangeGroup {
  scene: string;
  timecode_frames: number;
  changes: Change[];
  total_delta_frames: number;
  is_re_edit: boolean;
}

interface ClipMatch {
  before_idx: number;
  after_idx: number;
  match_quality: Confidence;
}

export const DEFAULT_LEADER_FRAMES = 192;
const RE_EDIT_MERGE_WINDOW = 120;
const RE_EDIT_MIN_CHANGES = 3;
const MAX_SOURCE_GAP_FRAMES = 48;

export interface DetectOptions {
  leader_frames: number;
  track_filter: number[];
}

export function detectChanges(before: Timeline, after: Timeline): Change[] {
  return detectChangesWithOptions(before, after, { leader_frames: DEFAULT_LEADER_FRAMES, track_filter: [] });
}

export function detectChangesWithOptions(before: Timeline, after: Timeline, opts: DetectOptions): Change[] {
  const beforeClips = filterContentClips(before.clips, opts);
  const afterClips = filterContentClips(after.clips, opts);

  const matches = matchClips(beforeClips, afterClips);
  let changes: Change[] = [];

  const beforeMatched = new Array(beforeClips.length).fill(false);
  const afterMatched = new Array(afterClips.length).fill(false);

  for (const m of matches) {
    beforeMatched[m.before_idx] = true;
    afterMatched[m.after_idx] = true;

    const bc = beforeClips[m.before_idx];
    const ac = afterClips[m.after_idx];
    detectTrimChanges(bc, ac, m.match_quality, changes);
  }

  // Removed shots
  for (let i = 0; i < beforeClips.length; i++) {
    if (!beforeMatched[i]) {
      const bc = beforeClips[i];
      const scene = resolveScene(bc, beforeClips, i);
      const tc_frames = findRemovalPosition(i, matches, afterClips);
      changes.push({
        scene,
        timecode_frames: tc_frames,
        description: changeTypeDescription("ShotRemoved", bc.end - bc.start),
        delta_frames: -(bc.end - bc.start),
        confidence: "Medium",
        change_type: "ShotRemoved",
        clip_name: bc.name,
      });
    }
  }

  // Added shots
  for (let i = 0; i < afterClips.length; i++) {
    if (!afterMatched[i]) {
      const ac = afterClips[i];
      const scene = resolveScene(ac, afterClips, i);
      changes.push({
        scene,
        timecode_frames: ac.start,
        description: changeTypeDescription("ShotAdded", ac.end - ac.start),
        delta_frames: ac.end - ac.start,
        confidence: "Medium",
        change_type: "ShotAdded",
        clip_name: ac.name,
      });
    }
  }

  detectJumpCuts(beforeClips, afterClips, matches, changes);

  changes.sort((a, b) => a.timecode_frames - b.timecode_frames);

  const matchedClipNames = matches.map((m) => afterClips[m.after_idx].name);

  changes = detectCameraSwaps(changes, beforeClips, afterClips);
  changes = detectShotReplacements(changes);
  changes = detectEditPointShifts(changes, matchedClipNames);
  changes = dedupIdenticalChanges(changes);
  changes = mergeConsecutiveSameType(changes);
  changes = mergeSameClipTrims(changes);

  return changes;
}

function dedupIdenticalChanges(changes: Change[]): Change[] {
  const result: Change[] = [];
  for (const change of changes) {
    const isDup = result.some(
      (e) =>
        e.change_type === change.change_type &&
        e.clip_name === change.clip_name &&
        Math.abs(e.timecode_frames - change.timecode_frames) <= 2,
    );
    if (!isDup) result.push(change);
  }
  return result;
}

function mergeConsecutiveSameType(changes: Change[]): Change[] {
  if (!changes.length) return changes;
  const result: Change[] = [];
  let i = 0;

  while (i < changes.length) {
    const current = changes[i];
    const isShotType =
      current.change_type === "ShotAdded" ||
      current.change_type === "ShotRemoved" ||
      current.change_type === "ShotReplaced";

    let runEnd = i;
    while (runEnd + 1 < changes.length) {
      const next = changes[runEnd + 1];
      if (next.change_type !== current.change_type) break;
      if (isShotType) {
        runEnd++;
      } else {
        if (Math.abs(next.timecode_frames - current.timecode_frames) <= 2) {
          runEnd++;
        } else {
          break;
        }
      }
    }

    const runLen = runEnd - i + 1;
    if (runLen > 1 && isShotType) {
      let totalDelta = 0;
      const clipNames: string[] = [];
      for (let j = i; j <= runEnd; j++) {
        totalDelta += changes[j].delta_frames;
        clipNames.push(changes[j].clip_name);
      }

      const desc =
        current.change_type === "ShotRemoved"
          ? `${runLen} shots removed`
          : current.change_type === "ShotAdded"
          ? `${runLen} shots added`
          : `${runLen} shots replaced`;

      result.push({
        ...current,
        description: desc,
        delta_frames: totalDelta,
        clip_name: clipNames.join(", "),
      });
      i = runEnd + 1;
    } else {
      for (let j = i; j <= runEnd; j++) result.push(changes[j]);
      i = runEnd + 1;
    }
  }

  return result;
}

function mergeSameClipTrims(changes: Change[]): Change[] {
  const consumed = new Array(changes.length).fill(false);
  const result: Change[] = [];

  for (let i = 0; i < changes.length; i++) {
    if (consumed[i]) continue;
    const a = changes[i];
    const aIsHead = a.change_type === "RemovedFromHead" || a.change_type === "AddedToHead";
    const aIsTail = a.change_type === "RemovedFromTail" || a.change_type === "AddedToTail";

    if (!aIsHead && !aIsTail) {
      result.push(a);
      continue;
    }

    let found = -1;
    for (let j = i + 1; j < changes.length; j++) {
      if (consumed[j]) continue;
      const b = changes[j];
      if (b.clip_name !== a.clip_name) continue;
      if (Math.abs(b.timecode_frames - a.timecode_frames) > 2) continue;
      const bIsHead = b.change_type === "RemovedFromHead" || b.change_type === "AddedToHead";
      const bIsTail = b.change_type === "RemovedFromTail" || b.change_type === "AddedToTail";
      if ((aIsHead && bIsTail) || (aIsTail && bIsHead)) {
        found = j;
        break;
      }
    }

    if (found >= 0) {
      consumed[found] = true;
      const headChange = aIsHead ? a : changes[found];
      const tailChange = aIsHead ? changes[found] : a;
      const headFrames = Math.abs(headChange.delta_frames);
      const tailFrames = Math.abs(tailChange.delta_frames);
      const totalDelta = headChange.delta_frames + tailChange.delta_frames;
      const headVerb = headChange.delta_frames >= 0 ? "Added" : "Removed";
      const headPrep = headChange.delta_frames >= 0 ? "to" : "from";
      const tailVerb = tailChange.delta_frames >= 0 ? "added" : "removed";
      const tailPrep = tailChange.delta_frames >= 0 ? "to" : "from";
      const description = `${headVerb} ${headFrames}fr ${headPrep} head and ${tailVerb} ${tailFrames}fr ${tailPrep} tail`;
      result.push({ ...a, description, delta_frames: totalDelta });
    } else {
      result.push(a);
    }
  }
  return result;
}

export function groupChanges(changes: Change[]): ChangeGroup[] {
  if (!changes.length) return [];

  const groups: ChangeGroup[] = [];
  let currentGroup: ChangeGroup | null = null;

  for (const change of changes) {
    const shouldStartNew = !currentGroup || Math.abs(change.timecode_frames - currentGroup.timecode_frames) > 2;
    if (shouldStartNew) {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = {
        scene: change.scene,
        timecode_frames: change.timecode_frames,
        changes: [change],
        total_delta_frames: change.delta_frames,
        is_re_edit: false,
      };
    } else if (currentGroup) {
      currentGroup.total_delta_frames += change.delta_frames;
      currentGroup.changes.push(change);
    }
  }
  if (currentGroup) groups.push(currentGroup);

  for (const g of groups) {
    g.is_re_edit = g.changes.length >= 3;
  }

  return mergeDenseGroups(groups);
}

function mergeDenseGroups(groups: ChangeGroup[]): ChangeGroup[] {
  if (groups.length < 2) return groups;

  const merged: ChangeGroup[] = [];
  let runStart = 0;

  while (runStart < groups.length) {
    let runEnd = runStart;
    let totalChanges = groups[runStart].changes.length;

    while (runEnd + 1 < groups.length) {
      const gap = groups[runEnd + 1].timecode_frames - groups[runEnd].timecode_frames;
      if (gap <= RE_EDIT_MERGE_WINDOW) {
        runEnd++;
        totalChanges += groups[runEnd].changes.length;
      } else {
        break;
      }
    }

    if (runEnd > runStart && totalChanges >= RE_EDIT_MIN_CHANGES) {
      const allChanges: Change[] = [];
      let totalDelta = 0;
      const scene = groups[runStart].scene;
      const tc = groups[runStart].timecode_frames;
      for (let gi = runStart; gi <= runEnd; gi++) {
        allChanges.push(...groups[gi].changes);
        totalDelta += groups[gi].total_delta_frames;
      }
      merged.push({ scene, timecode_frames: tc, changes: allChanges, total_delta_frames: totalDelta, is_re_edit: true });
    } else {
      for (let gi = runStart; gi <= runEnd; gi++) {
        merged.push(groups[gi]);
      }
    }

    runStart = runEnd + 1;
  }

  return merged;
}

function filterContentClips(clips: Clip[], opts: DetectOptions): Clip[] {
  if (!clips.length) return [];

  const maxEnd = Math.max(...clips.map((c) => c.end));
  const leader = opts.leader_frames;

  const hasTailLeader = clips.filter((c) => c.end === maxEnd).some((c) => isLeaderClip(c.name));
  const tailCutoff = hasTailLeader ? maxEnd - leader : maxEnd;

  return clips.filter(
    (c) =>
      c.enabled &&
      c.start >= leader &&
      c.end <= tailCutoff &&
      (opts.track_filter.length === 0 || opts.track_filter.includes(c.track_index)),
  );
}

function isLeaderClip(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("leader") ||
    lower.includes("jtb_") ||
    lower.includes("slate") ||
    lower.includes("endofproject") ||
    lower.includes("end_of") ||
    lower.includes("countdown") ||
    lower.includes("bars")
  );
}

function matchClips(before: Clip[], after: Clip[]): ClipMatch[] {
  const matches: ClipMatch[] = [];
  const afterUsed = new Array(after.length).fill(false);

  for (let bi = 0; bi < before.length; bi++) {
    const bc = before[bi];
    let bestAi = -1;
    let bestQuality: Confidence = "Low";
    let bestScore = 0;

    for (let ai = 0; ai < after.length; ai++) {
      if (afterUsed[ai]) continue;
      const ac = after[ai];
      const [isMatch, quality, score] = clipsMatch(bc, ac);
      if (isMatch && score > bestScore) {
        bestAi = ai;
        bestQuality = quality;
        bestScore = score;
      }
    }

    if (bestAi >= 0) {
      afterUsed[bestAi] = true;
      matches.push({ before_idx: bi, after_idx: bestAi, match_quality: bestQuality });
    }
  }

  return matches;
}

function clipsMatch(bc: Clip, ac: Clip): [boolean, Confidence, number] {
  if (bc.name && bc.name === ac.name) {
    if (bc.source_file && bc.source_file === ac.source_file) {
      const overlap = sourceOverlap(bc, ac);
      if (overlap > 0) return [true, "High", 1000 + overlap];
      const gap = sourceGap(bc, ac);
      if (gap <= MAX_SOURCE_GAP_FRAMES) return [true, "Medium", 900 - gap];
      return [false, "Low", 0];
    }
    if (bc.source_out > bc.source_in && ac.source_out > ac.source_in) {
      const overlap = sourceOverlap(bc, ac);
      if (overlap > 0) return [true, "Medium", 500 + overlap];
      const gap = sourceGap(bc, ac);
      if (gap <= MAX_SOURCE_GAP_FRAMES) return [true, "Medium", 450 - gap];
      return [false, "Low", 0];
    }
    return [true, "Medium", 400];
  }

  if (bc.source_file && bc.source_file === ac.source_file) {
    const overlap = sourceOverlap(bc, ac);
    if (overlap > 0) return [true, "Medium", 400 + overlap];
  }

  return [false, "Low", 0];
}

function sourceOverlap(a: Clip, b: Clip): number {
  const start = Math.max(a.source_in, b.source_in);
  const end = Math.min(a.source_out, b.source_out);
  return end > start ? end - start : 0;
}

function sourceGap(a: Clip, b: Clip): number {
  const gapStart = Math.min(a.source_out, b.source_out);
  const gapEnd = Math.max(a.source_in, b.source_in);
  return gapEnd > gapStart ? gapEnd - gapStart : 0;
}

function detectTrimChanges(before: Clip, after: Clip, quality: Confidence, changes: Change[]) {
  const scene = after.scene ? normalizeScene(after.scene) : sceneFromName(after.name);

  const headDelta = before.source_in - after.source_in;
  if (headDelta !== 0) {
    const ct: ChangeType = headDelta > 0 ? "AddedToHead" : "RemovedFromHead";
    changes.push({
      scene,
      timecode_frames: after.start,
      description: changeTypeDescription(ct, headDelta),
      delta_frames: headDelta,
      confidence: quality,
      change_type: ct,
      clip_name: after.name,
    });
  }

  const tailDelta = after.source_out - before.source_out;
  if (tailDelta !== 0) {
    const ct: ChangeType = tailDelta > 0 ? "AddedToTail" : "RemovedFromTail";
    changes.push({
      scene,
      timecode_frames: after.start,
      description: changeTypeDescription(ct, tailDelta),
      delta_frames: tailDelta,
      confidence: quality,
      change_type: ct,
      clip_name: after.name,
    });
  }
}

function detectJumpCuts(before: Clip[], after: Clip[], matches: ClipMatch[], changes: Change[]) {
  for (let bi = 0; bi < before.length; bi++) {
    const bc = before[bi];

    const matchedAfterIndices = matches.filter((m) => m.before_idx === bi).map((m) => m.after_idx);
    const afterMatches = [...matchedAfterIndices];

    for (let ai = 0; ai < after.length; ai++) {
      if (afterMatches.includes(ai)) continue;
      const ac = after[ai];
      if (
        ac.name === bc.name &&
        ac.name &&
        (ac.source_file === bc.source_file || !bc.source_file) &&
        sourceOverlap(bc, ac) > 0
      ) {
        const isAdjacent = afterMatches.some((mi) => sourceGap(after[mi], ac) <= MAX_SOURCE_GAP_FRAMES);
        if (isAdjacent) afterMatches.push(ai);
      }
    }

    if (afterMatches.length > 1) {
      const fragments = afterMatches.map((i) => after[i]).sort((a, b) => a.source_in - b.source_in);
      for (let wi = 0; wi < fragments.length - 1; wi++) {
        const gap = fragments[wi + 1].source_in - fragments[wi].source_out;
        if (gap > 0) {
          const scene = fragments[wi].scene
            ? normalizeScene(fragments[wi].scene)
            : sceneFromName(fragments[wi].name);
          changes.push({
            scene,
            timecode_frames: fragments[wi].start,
            description: changeTypeDescription("RemovedFromMiddle", gap),
            delta_frames: -gap,
            confidence: "Medium",
            change_type: "RemovedFromMiddle",
            clip_name: fragments[wi].name,
          });
        }
      }
    }
  }
}

function resolveScene(clip: Clip, allClips: Clip[], idx: number): string {
  if (clip.scene) return normalizeScene(clip.scene);
  const fromName = sceneFromName(clip.name);
  if (fromName) return fromName;
  if (idx > 0 && allClips[idx - 1].scene) return normalizeScene(allClips[idx - 1].scene);
  return "";
}

function findRemovalPosition(beforeIdx: number, matches: ClipMatch[], afterClips: Clip[]): number {
  let nearestAfterPos = 0;
  for (const m of matches) {
    if (m.before_idx < beforeIdx) {
      const afterEnd = afterClips[m.after_idx].end;
      if (afterEnd > nearestAfterPos) nearestAfterPos = afterEnd;
    }
  }
  return nearestAfterPos;
}

function detectShotReplacements(changes: Change[]): Change[] {
  const consumed = new Array(changes.length).fill(false);
  const result: Change[] = [];

  for (let i = 0; i < changes.length; i++) {
    if (consumed[i]) continue;
    const a = changes[i];
    if (a.change_type !== "ShotRemoved" && a.change_type !== "ShotAdded") {
      result.push(a);
      continue;
    }

    const lookingFor: ChangeType = a.change_type === "ShotRemoved" ? "ShotAdded" : "ShotRemoved";
    let found = -1;
    for (let j = 0; j < changes.length; j++) {
      if (j === i || consumed[j]) continue;
      if (changes[j].change_type !== lookingFor) continue;
      if (Math.abs(a.timecode_frames - changes[j].timecode_frames) <= 2) {
        found = j;
        break;
      }
    }

    if (found >= 0) {
      consumed[found] = true;
      const removed = a.change_type === "ShotRemoved" ? a : changes[found];
      const added = a.change_type === "ShotRemoved" ? changes[found] : a;
      const netDelta = added.delta_frames + removed.delta_frames;
      const description = netDelta === 0 ? "Shot replaced (no TRT change)" : changeTypeDescription("ShotReplaced", netDelta);
      result.push({
        scene: removed.scene,
        timecode_frames: removed.timecode_frames,
        description,
        delta_frames: netDelta,
        confidence: "Medium",
        change_type: "ShotReplaced",
        clip_name: `${removed.clip_name} -> ${added.clip_name}`,
      });
    } else {
      result.push(a);
    }
  }
  return result;
}

function detectEditPointShifts(changes: Change[], matchedClipNames: string[]): Change[] {
  const consumed = new Array(changes.length).fill(false);
  const result: Change[] = [];

  for (let i = 0; i < changes.length; i++) {
    if (consumed[i]) continue;
    const a = changes[i];
    const isTail = a.change_type === "RemovedFromTail" || a.change_type === "AddedToTail";
    const isHead = a.change_type === "RemovedFromHead" || a.change_type === "AddedToHead";

    if (!isTail && !isHead) { result.push(a); continue; }
    if (!matchedClipNames.includes(a.clip_name)) { result.push(a); continue; }

    let foundPair: { j: number; net: number } | null = null;
    for (let j = 0; j < changes.length; j++) {
      if (j === i || consumed[j]) continue;
      const b = changes[j];
      if (Math.abs(a.timecode_frames - b.timecode_frames) > 2) continue;
      if (b.clip_name === a.clip_name) continue;
      if (!matchedClipNames.includes(b.clip_name)) continue;

      const bIsTail = b.change_type === "RemovedFromTail" || b.change_type === "AddedToTail";
      const bIsHead = b.change_type === "RemovedFromHead" || b.change_type === "AddedToHead";

      const isComplement = (isTail && bIsHead) || (isHead && bIsTail);
      if (isComplement) {
        const net = a.delta_frames + b.delta_frames;
        if (Math.abs(net) <= 2) {
          foundPair = { j, net };
          break;
        }
      }
    }

    if (foundPair) {
      consumed[foundPair.j] = true;
      const tailChange = isTail ? a : changes[foundPair.j];
      const headChange = isTail ? changes[foundPair.j] : a;
      const shiftAmount = Math.max(Math.abs(tailChange.delta_frames), Math.abs(headChange.delta_frames));
      const direction = tailChange.delta_frames < 0 ? "earlier" : "later";
      const description = `Edit point shifted ${direction} by ${shiftAmount}fr (no TRT change)`;
      result.push({
        scene: a.scene,
        timecode_frames: a.timecode_frames,
        description,
        delta_frames: foundPair.net,
        confidence: a.confidence,
        change_type: "EditPointShifted",
        clip_name: `${tailChange.clip_name} / ${headChange.clip_name}`,
      });
    } else {
      result.push(a);
    }
  }
  return result;
}

function parseClipName(name: string): { sceneBase: string; camera: string; take: string } | null {
  const dashPos = name.indexOf("-");
  if (dashPos < 0) return null;
  const prefix = name.slice(0, dashPos);
  const takePart = name.slice(dashPos + 1);
  if (!prefix) return null;

  const lastChar = prefix[prefix.length - 1];
  if (lastChar >= "A" && lastChar <= "Z") {
    const sceneBase = prefix.slice(0, prefix.length - 1);
    if (!sceneBase) return null;
    const take = takePart.split("-")[0];
    return { sceneBase, camera: lastChar, take };
  }
  return null;
}

function detectCameraSwaps(changes: Change[], _beforeClips: Clip[], _afterClips: Clip[]): Change[] {
  const claimed = new Array(changes.length).fill(false);
  const swapPairs: Array<[number, number]> = [];

  for (let i = 0; i < changes.length; i++) {
    if (claimed[i] || changes[i].change_type !== "ShotRemoved") continue;
    const a = changes[i];
    for (let j = 0; j < changes.length; j++) {
      if (j === i || claimed[j] || changes[j].change_type !== "ShotAdded") continue;
      const b = changes[j];
      if (Math.abs(a.timecode_frames - b.timecode_frames) > 24) continue;
      const ap = parseClipName(a.clip_name);
      const bp = parseClipName(b.clip_name);
      if (ap && bp && ap.sceneBase === bp.sceneBase && ap.take === bp.take && ap.camera !== bp.camera) {
        claimed[i] = true;
        claimed[j] = true;
        swapPairs.push([i, j]);
        break;
      }
    }
  }

  const removeSet = new Set<number>();
  const inserts: Array<{ idx: number; change: Change }> = [];

  for (const [ri, ai] of swapPairs) {
    const removed = changes[ri];
    const added = changes[ai];
    const fromCam = parseClipName(removed.clip_name)?.camera ?? "";
    const toCam = parseClipName(added.clip_name)?.camera ?? "";
    const delta = added.delta_frames + removed.delta_frames;
    inserts.push({
      idx: ri,
      change: {
        scene: removed.scene,
        timecode_frames: removed.timecode_frames,
        description: `Camera swap ${fromCam} -> ${toCam} (same take, different angle)`,
        delta_frames: delta,
        confidence: "High",
        change_type: "CameraSwap",
        clip_name: `${removed.clip_name} -> ${added.clip_name}`,
      },
    });
    removeSet.add(ri);
    removeSet.add(ai);
  }

  const result: Change[] = [];
  for (let i = 0; i < changes.length; i++) {
    if (removeSet.has(i)) continue;
    const insert = inserts.find((ins) => ins.idx === i);
    if (insert) result.push(insert.change);
    result.push(changes[i]);
  }
  // Remove duplicates from the insert logic
  const final: Change[] = [];
  const seen = new Set<number>();
  for (const c of result) {
    // Use object identity to avoid duplication from the insert + skip logic
    if (!seen.has(result.indexOf(c))) {
      seen.add(result.indexOf(c));
      final.push(c);
    }
  }
  return final;
}

export function computeAnalysisStats(changes: Change[]) {
  let trims = 0, shots_added = 0, shots_removed = 0, shots_replaced = 0,
    camera_swaps = 0, edit_shifts = 0, jump_cuts = 0;
  for (const c of changes) {
    switch (c.change_type) {
      case "RemovedFromHead": case "RemovedFromTail": case "AddedToHead": case "AddedToTail": trims++; break;
      case "ShotAdded": shots_added++; break;
      case "ShotRemoved": shots_removed++; break;
      case "ShotReplaced": shots_replaced++; break;
      case "CameraSwap": camera_swaps++; break;
      case "EditPointShifted": edit_shifts++; break;
      case "RemovedFromMiddle": jump_cuts++; break;
    }
  }
  return { trims, shots_added, shots_removed, shots_replaced, camera_swaps, edit_shifts, jump_cuts };
}
