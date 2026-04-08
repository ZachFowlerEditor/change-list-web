// Ported from conform_generator.rs

import type { Clip, Timeline } from "./timeline";
import type { Change, ChangeType, Confidence } from "./changeDetector";
import { ticksPerFrame, framesToTimecodeWithTb, framesToDeltaTimecode } from "./timeline";

export interface ConformConfig {
  beforeRefPathurl: string;
  beforeRefAudioPathurl: string;
  beforeRefDuration: number;
  afterRefPathurl: string;
  afterRefAudioPathurl: string;
  afterRefDuration: number;
  opacity: number;
  sequenceName: string;
  leaderFrames: number;
  trackFilter: number[];
}

interface ConformSegment {
  tlStart: number;
  tlEnd: number;
  srcIn: number;
  srcOut: number;
  clipName: string;
}

interface ConformResult {
  segments: ConformSegment[];
  removed: ConformSegment[];
}

interface SequenceMarker {
  frame: number;
  outFrame: number;
  name: string;
  comment: string;
  color: string;
}

// Marker colors
const MARKER_GREEN = "4278255360";
const MARKER_YELLOW = "4294967040";
const MARKER_RED = "4294901760";
const MARKER_BLUE = "4278190335";
const MARKER_CYAN = "4278255615";

const DEFAULT_BEFORE_REF_NAME = "Before_Timeline_REF";
const DEFAULT_AFTER_REF_NAME = "After_Timeline_REF";

function refNameFromPathurl(pathurl: string, prefix: string, fallback: string): string {
  const decoded = pathurl.replace(/%20/g, " ");
  const parts = decoded.split("/");
  const filename = parts[parts.length - 1];
  if (filename && filename.includes(".")) {
    return `${prefix}_${filename}`;
  }
  return fallback;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isLeaderClip(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("leader") || lower.includes("jtb_") || lower.includes("slate")
    || lower.includes("endofproject") || lower.includes("end_of")
    || lower.includes("countdown") || lower.includes("bars");
}

function sourceOverlap(a: Clip, b: Clip): number {
  const start = Math.max(a.source_in, b.source_in);
  const end = Math.min(a.source_out, b.source_out);
  return end > start ? end - start : 0;
}

function filterContentClips(clips: Clip[], trackFilter: number[], leader: number): Clip[] {
  if (clips.length === 0) return [];
  const maxEnd = clips.reduce((mx, c) => Math.max(mx, c.end), 0);

  const hasTailLeader = clips
    .filter(c => c.end === maxEnd)
    .some(c => isLeaderClip(c.name));
  const tailCutoff = hasTailLeader ? maxEnd - leader : maxEnd;

  return clips.filter(c =>
    c.enabled
    && c.start >= leader
    && c.end <= tailCutoff
    && (trackFilter.length === 0 || trackFilter.includes(c.track_index))
  );
}

function mapBeforeToAfter(beforeFrame: number, segments: ConformSegment[]): number {
  let bestSeg: ConformSegment | null = null;
  let bestDist = Infinity;

  for (const seg of segments) {
    if (beforeFrame >= seg.srcIn && beforeFrame < seg.srcOut) {
      return seg.tlStart + (beforeFrame - seg.srcIn);
    }
    const dist = beforeFrame < seg.srcIn
      ? seg.srcIn - beforeFrame
      : beforeFrame - seg.srcOut;
    if (dist < bestDist) {
      bestDist = dist;
      bestSeg = seg;
    }
  }

  if (bestSeg) {
    return beforeFrame + (bestSeg.tlStart - bestSeg.srcIn);
  }
  return beforeFrame;
}

function computeConformSegments(
  before: Timeline, after: Timeline, config: ConformConfig
): ConformResult {
  const leader = config.leaderFrames;
  const beforeClips = filterContentClips(before.clips, config.trackFilter, leader);
  const afterClips = filterContentClips(after.clips, config.trackFilter, leader);

  const segments: ConformSegment[] = [];

  // Pre-content gap
  if (beforeClips.length > 0 && afterClips.length > 0) {
    const beforeFirst = beforeClips[0].start;
    const afterFirst = afterClips[0].start;
    if (beforeFirst === afterFirst && beforeFirst > leader) {
      segments.push({
        tlStart: leader, tlEnd: beforeFirst,
        srcIn: leader, srcOut: beforeFirst,
        clipName: "",
      });
    }
  }

  const beforeUsed: boolean[] = new Array(beforeClips.length).fill(false);
  const trimmedSegments: ConformSegment[] = [];

  for (const ac of afterClips) {
    let bestIdx = -1;
    let bestScore = -1;

    for (let bi = 0; bi < beforeClips.length; bi++) {
      if (beforeUsed[bi]) continue;
      const bc = beforeClips[bi];

      const nameMatch = bc.name !== "" && bc.name === ac.name;
      const masterMatch = bc.master_clip_id !== "" && bc.master_clip_id === ac.master_clip_id;
      const fileMatch = bc.source_file !== "" && bc.source_file === ac.source_file;

      if (nameMatch || masterMatch || fileMatch) {
        const overlap = sourceOverlap(bc, ac);
        if (overlap > 0) {
          const score = overlap
            + (nameMatch ? 10000 : 0)
            + (masterMatch ? 5000 : 0);
          if (bestIdx === -1 || score > bestScore) {
            bestIdx = bi;
            bestScore = score;
          }
        }
      }
    }

    if (bestIdx >= 0) {
      beforeUsed[bestIdx] = true;
      const bc = beforeClips[bestIdx];

      const overlapStart = Math.max(bc.source_in, ac.source_in);
      const overlapEnd = Math.min(bc.source_out, ac.source_out);
      if (overlapEnd <= overlapStart) continue;

      const afterTlStart = ac.start + (overlapStart - ac.source_in);
      const afterTlEnd = ac.start + (overlapEnd - ac.source_in);
      const beforeRenderStart = bc.start + (overlapStart - bc.source_in);
      const beforeRenderEnd = bc.start + (overlapEnd - bc.source_in);

      segments.push({
        tlStart: afterTlStart, tlEnd: afterTlEnd,
        srcIn: beforeRenderStart, srcOut: beforeRenderEnd,
        clipName: bc.name,
      });

      // Head trim
      if (bc.source_in < ac.source_in) {
        const trimFrames = ac.source_in - bc.source_in;
        trimmedSegments.push({
          tlStart: ac.start - trimFrames, tlEnd: ac.start,
          srcIn: bc.start, srcOut: bc.start + trimFrames,
          clipName: bc.name,
        });
      }
      // Tail trim
      if (bc.source_out > ac.source_out) {
        const trimFrames = bc.source_out - ac.source_out;
        trimmedSegments.push({
          tlStart: ac.end, tlEnd: ac.end + trimFrames,
          srcIn: bc.end - trimFrames, srcOut: bc.end,
          clipName: bc.name,
        });
      }
    }
  }

  segments.sort((a, b) => a.tlStart - b.tlStart);

  // Merge contiguous segments
  const merged: ConformSegment[] = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (last && seg.tlStart === last.tlEnd && seg.srcIn === last.srcOut) {
      last.tlEnd = seg.tlEnd;
      last.srcOut = seg.srcOut;
      continue;
    }
    merged.push({ ...seg });
  }

  // Remove tiny segments (< 3 frames)
  const filtered = merged.filter(s => (s.tlEnd - s.tlStart) >= 3);

  // Collect removed clips
  const removed: ConformSegment[] = [];
  for (let bi = 0; bi < beforeClips.length; bi++) {
    if (!beforeUsed[bi]) {
      const bc = beforeClips[bi];
      const clipDur = bc.end - bc.start;
      const afterPos = mapBeforeToAfter(bc.start, filtered);
      removed.push({
        tlStart: afterPos, tlEnd: afterPos + clipDur,
        srcIn: bc.start, srcOut: bc.end,
        clipName: bc.name,
      });
    }
  }
  removed.push(...trimmedSegments);
  removed.sort((a, b) => a.tlStart - b.tlStart);

  return { segments: filtered, removed };
}

function markerColor(change: Change): string {
  switch (change.change_type) {
    // Trims
    case "RemovedFromHead":
    case "RemovedFromTail":
    case "AddedToHead":
    case "AddedToTail":
    case "Slipped":
      return MARKER_YELLOW;
    // Additions
    case "ShotAdded":
      return MARKER_GREEN;
    // Removals
    case "ShotRemoved":
      return MARKER_RED;
    // Combo / other
    default:
      return MARKER_BLUE;
  }
}

function buildMarkers(changes: Change[]): SequenceMarker[] {
  const RANGE_SPREAD_FRAMES = 1; // each stacked marker extends 1 more frame

  const markers: SequenceMarker[] = changes.map((c, i) => {
    const counter = i + 1;
    const delta = framesToDeltaTimecode(c.delta_frames);
    return {
      frame: c.timecode_frames,
      outFrame: -1,
      name: `#${counter}`,
      comment: `${c.description} | ${delta} | ${c.clip_name}`,
      color: markerColor(c),
    };
  });

  // For markers at the same timecode, make them range markers so they fan out
  // visually on the timeline. The first stays a point marker; each subsequent
  // one gets a progressively longer range.
  const frameGroups = new Map<number, number>();
  for (const m of markers) {
    const count = frameGroups.get(m.frame) ?? 0;
    if (count > 0) {
      m.outFrame = m.frame + count * RANGE_SPREAD_FRAMES;
    }
    frameGroups.set(m.frame, count + 1);
  }

  return markers;
}

// ---------------------------------------------------------------------------
// XML rendering helpers
// ---------------------------------------------------------------------------

function writeRate(indent: number, tb: number, ntsc: boolean): string {
  const t = "\t".repeat(indent);
  return `${t}<rate>\n${t}\t<timebase>${tb}</timebase>\n${t}\t<ntsc>${ntsc ? "TRUE" : "FALSE"}</ntsc>\n${t}</rate>\n`;
}

function writeVideoFormat(tl: Timeline): string {
  let o = "";
  o += `\t\t\t\t<format>\n`;
  o += `\t\t\t\t\t<samplecharacteristics>\n`;
  o += writeRate(6, tl.timebase, tl.ntsc);
  o += `\t\t\t\t\t\t<codec>\n\t\t\t\t\t\t\t<name>Apple ProRes 422</name>\n\t\t\t\t\t\t</codec>\n`;
  o += `\t\t\t\t\t\t<width>${tl.width}</width>\n`;
  o += `\t\t\t\t\t\t<height>${tl.height}</height>\n`;
  o += `\t\t\t\t\t\t<anamorphic>FALSE</anamorphic>\n`;
  o += `\t\t\t\t\t\t<pixelaspectratio>square</pixelaspectratio>\n`;
  o += `\t\t\t\t\t\t<fielddominance>none</fielddominance>\n`;
  o += `\t\t\t\t\t</samplecharacteristics>\n`;
  o += `\t\t\t\t</format>\n`;
  return o;
}

function writeFileDef(
  fileId: string, clipName: string, pathurl: string,
  duration: number, startTc: number, tcStr: string, tl: Timeline
): string {
  const displayFormat = tl.ntsc && tl.timebase === 30 ? "DF" : "NDF";
  let o = "";
  o += `\t\t\t\t\t\t<file id="${fileId}">\n`;
  o += `\t\t\t\t\t\t\t<name>${escapeXml(clipName)}</name>\n`;
  o += `\t\t\t\t\t\t\t<pathurl>${escapeXml(pathurl)}</pathurl>\n`;
  o += writeRate(7, tl.timebase, tl.ntsc);
  o += `\t\t\t\t\t\t\t<duration>${duration}</duration>\n`;
  o += `\t\t\t\t\t\t\t<timecode>\n`;
  o += writeRate(8, tl.timebase, tl.ntsc);
  o += `\t\t\t\t\t\t\t\t<string>${tcStr}</string>\n`;
  o += `\t\t\t\t\t\t\t\t<frame>${startTc}</frame>\n`;
  o += `\t\t\t\t\t\t\t\t<displayformat>${displayFormat}</displayformat>\n`;
  o += `\t\t\t\t\t\t\t</timecode>\n`;
  o += `\t\t\t\t\t\t\t<media>\n`;
  o += `\t\t\t\t\t\t\t\t<video>\n`;
  o += `\t\t\t\t\t\t\t\t\t<samplecharacteristics>\n`;
  o += writeRate(9, tl.timebase, tl.ntsc);
  o += `\t\t\t\t\t\t\t\t\t\t<width>${tl.width}</width>\n`;
  o += `\t\t\t\t\t\t\t\t\t\t<height>${tl.height}</height>\n`;
  o += `\t\t\t\t\t\t\t\t\t\t<anamorphic>FALSE</anamorphic>\n`;
  o += `\t\t\t\t\t\t\t\t\t\t<pixelaspectratio>square</pixelaspectratio>\n`;
  o += `\t\t\t\t\t\t\t\t\t\t<fielddominance>none</fielddominance>\n`;
  o += `\t\t\t\t\t\t\t\t\t</samplecharacteristics>\n`;
  o += `\t\t\t\t\t\t\t\t</video>\n`;
  o += `\t\t\t\t\t\t\t\t<audio>\n`;
  o += `\t\t\t\t\t\t\t\t\t<samplecharacteristics>\n`;
  o += `\t\t\t\t\t\t\t\t\t\t<depth>16</depth>\n`;
  o += `\t\t\t\t\t\t\t\t\t\t<samplerate>48000</samplerate>\n`;
  o += `\t\t\t\t\t\t\t\t\t</samplecharacteristics>\n`;
  o += `\t\t\t\t\t\t\t\t\t<channelcount>2</channelcount>\n`;
  o += `\t\t\t\t\t\t\t\t</audio>\n`;
  o += `\t\t\t\t\t\t\t</media>\n`;
  o += `\t\t\t\t\t\t</file>\n`;
  return o;
}

function writeAudioFileDef(
  fileId: string, clipName: string, pathurl: string,
  duration: number, startTc: number, tcStr: string, tl: Timeline
): string {
  const displayFormat = tl.ntsc && tl.timebase === 30 ? "DF" : "NDF";
  let o = "";
  o += `\t\t\t\t\t\t<file id="${fileId}">\n`;
  o += `\t\t\t\t\t\t\t<name>${escapeXml(clipName)}</name>\n`;
  o += `\t\t\t\t\t\t\t<pathurl>${escapeXml(pathurl)}</pathurl>\n`;
  o += writeRate(7, tl.timebase, tl.ntsc);
  o += `\t\t\t\t\t\t\t<duration>${duration}</duration>\n`;
  o += `\t\t\t\t\t\t\t<timecode>\n`;
  o += writeRate(8, tl.timebase, tl.ntsc);
  o += `\t\t\t\t\t\t\t\t<string>${tcStr}</string>\n`;
  o += `\t\t\t\t\t\t\t\t<frame>${startTc}</frame>\n`;
  o += `\t\t\t\t\t\t\t\t<displayformat>${displayFormat}</displayformat>\n`;
  o += `\t\t\t\t\t\t\t</timecode>\n`;
  o += `\t\t\t\t\t\t\t<media>\n`;
  o += `\t\t\t\t\t\t\t\t<audio>\n`;
  o += `\t\t\t\t\t\t\t\t\t<samplecharacteristics>\n`;
  o += `\t\t\t\t\t\t\t\t\t\t<depth>16</depth>\n`;
  o += `\t\t\t\t\t\t\t\t\t\t<samplerate>48000</samplerate>\n`;
  o += `\t\t\t\t\t\t\t\t\t</samplecharacteristics>\n`;
  o += `\t\t\t\t\t\t\t\t\t<channelcount>2</channelcount>\n`;
  o += `\t\t\t\t\t\t\t\t</audio>\n`;
  o += `\t\t\t\t\t\t\t</media>\n`;
  o += `\t\t\t\t\t\t</file>\n`;
  return o;
}

function writeClipitemWithSourceMarkers(
  clipId: string, clipName: string, fileId: string, masterclipId: string,
  tlStart: number, tlEnd: number, srcIn: number, srcOut: number,
  duration: number, opacity: number | null,
  fileDef: { pathurl: string; startTc: number; tcStr: string; fileName?: string } | null,
  tl: Timeline,
  sourceMarkers: [number, string][]
): string {
  const tpf = ticksPerFrame(tl.timebase, tl.ntsc);
  const ticksIn = srcIn * tpf;
  const ticksOut = srcOut * tpf;

  let o = "";
  o += `\t\t\t\t\t<clipitem id="${clipId}">\n`;
  o += `\t\t\t\t\t\t<masterclipid>${masterclipId}</masterclipid>\n`;
  o += `\t\t\t\t\t\t<name>${escapeXml(clipName)}</name>\n`;
  o += `\t\t\t\t\t\t<enabled>TRUE</enabled>\n`;
  o += `\t\t\t\t\t\t<duration>${duration}</duration>\n`;
  o += writeRate(6, tl.timebase, tl.ntsc);
  o += `\t\t\t\t\t\t<start>${tlStart}</start>\n`;
  o += `\t\t\t\t\t\t<end>${tlEnd}</end>\n`;
  o += `\t\t\t\t\t\t<in>${srcIn}</in>\n`;
  o += `\t\t\t\t\t\t<out>${srcOut}</out>\n`;
  o += `\t\t\t\t\t\t<pproTicksIn>${ticksIn}</pproTicksIn>\n`;
  o += `\t\t\t\t\t\t<pproTicksOut>${ticksOut}</pproTicksOut>\n`;
  o += `\t\t\t\t\t\t<alphatype>none</alphatype>\n`;
  o += `\t\t\t\t\t\t<pixelaspectratio>square</pixelaspectratio>\n`;
  o += `\t\t\t\t\t\t<anamorphic>FALSE</anamorphic>\n`;

  if (fileDef) {
    const fName = fileDef.fileName ?? clipName;
    o += writeFileDef(fileId, fName, fileDef.pathurl, duration, fileDef.startTc, fileDef.tcStr, tl);
  } else {
    o += `\t\t\t\t\t\t<file id="${fileId}"/>\n`;
  }

  if (opacity !== null) {
    o += `\t\t\t\t\t\t<filter>\n`;
    o += `\t\t\t\t\t\t\t<effect>\n`;
    o += `\t\t\t\t\t\t\t\t<name>Opacity</name>\n`;
    o += `\t\t\t\t\t\t\t\t<effectid>opacity</effectid>\n`;
    o += `\t\t\t\t\t\t\t\t<effectcategory>motion</effectcategory>\n`;
    o += `\t\t\t\t\t\t\t\t<effecttype>motion</effecttype>\n`;
    o += `\t\t\t\t\t\t\t\t<mediatype>video</mediatype>\n`;
    o += `\t\t\t\t\t\t\t\t<pproBypass>false</pproBypass>\n`;
    o += `\t\t\t\t\t\t\t\t<parameter authoringApp="PremierePro">\n`;
    o += `\t\t\t\t\t\t\t\t\t<parameterid>opacity</parameterid>\n`;
    o += `\t\t\t\t\t\t\t\t\t<name>opacity</name>\n`;
    o += `\t\t\t\t\t\t\t\t\t<valuemin>0</valuemin>\n`;
    o += `\t\t\t\t\t\t\t\t\t<valuemax>100</valuemax>\n`;
    o += `\t\t\t\t\t\t\t\t\t<value>${opacity}</value>\n`;
    o += `\t\t\t\t\t\t\t\t</parameter>\n`;
    o += `\t\t\t\t\t\t\t</effect>\n`;
    o += `\t\t\t\t\t\t</filter>\n`;
  }

  for (const [frame, name] of sourceMarkers) {
    o += `\t\t\t\t\t\t<marker>\n`;
    o += `\t\t\t\t\t\t\t<comment>${escapeXml(name)}</comment>\n`;
    o += `\t\t\t\t\t\t\t<name>${escapeXml(name)}</name>\n`;
    o += `\t\t\t\t\t\t\t<in>${frame}</in>\n`;
    o += `\t\t\t\t\t\t\t<out>-1</out>\n`;
    o += `\t\t\t\t\t\t</marker>\n`;
  }

  o += `\t\t\t\t\t</clipitem>\n`;
  return o;
}

function writeDisabledClipitem(
  clipId: string, clipName: string, fileId: string, masterclipId: string,
  tlStart: number, tlEnd: number, srcIn: number, srcOut: number,
  duration: number, tl: Timeline
): string {
  const tpf = ticksPerFrame(tl.timebase, tl.ntsc);
  const ticksIn = srcIn * tpf;
  const ticksOut = srcOut * tpf;

  let o = "";
  o += `\t\t\t\t\t<clipitem id="${clipId}">\n`;
  o += `\t\t\t\t\t\t<masterclipid>${masterclipId}</masterclipid>\n`;
  o += `\t\t\t\t\t\t<name>${escapeXml(clipName)}</name>\n`;
  o += `\t\t\t\t\t\t<enabled>FALSE</enabled>\n`;
  o += `\t\t\t\t\t\t<duration>${duration}</duration>\n`;
  o += writeRate(6, tl.timebase, tl.ntsc);
  o += `\t\t\t\t\t\t<start>${tlStart}</start>\n`;
  o += `\t\t\t\t\t\t<end>${tlEnd}</end>\n`;
  o += `\t\t\t\t\t\t<in>${srcIn}</in>\n`;
  o += `\t\t\t\t\t\t<out>${srcOut}</out>\n`;
  o += `\t\t\t\t\t\t<pproTicksIn>${ticksIn}</pproTicksIn>\n`;
  o += `\t\t\t\t\t\t<pproTicksOut>${ticksOut}</pproTicksOut>\n`;
  o += `\t\t\t\t\t\t<alphatype>none</alphatype>\n`;
  o += `\t\t\t\t\t\t<pixelaspectratio>square</pixelaspectratio>\n`;
  o += `\t\t\t\t\t\t<anamorphic>FALSE</anamorphic>\n`;
  o += `\t\t\t\t\t\t<file id="${fileId}"/>\n`;
  o += `\t\t\t\t\t</clipitem>\n`;
  return o;
}

function writeAudioClipitem(
  clipId: string, clipName: string, fileId: string, masterclipId: string,
  tlStart: number, tlEnd: number, srcIn: number, srcOut: number,
  duration: number, sourceTrack: number, tl: Timeline
): string {
  const tpf = ticksPerFrame(tl.timebase, tl.ntsc);
  const ticksIn = srcIn * tpf;
  const ticksOut = srcOut * tpf;

  let o = "";
  o += `\t\t\t\t\t<clipitem id="${clipId}">\n`;
  o += `\t\t\t\t\t\t<masterclipid>${masterclipId}</masterclipid>\n`;
  o += `\t\t\t\t\t\t<name>${escapeXml(clipName)}</name>\n`;
  o += `\t\t\t\t\t\t<enabled>TRUE</enabled>\n`;
  o += `\t\t\t\t\t\t<duration>${duration}</duration>\n`;
  o += writeRate(6, tl.timebase, tl.ntsc);
  o += `\t\t\t\t\t\t<start>${tlStart}</start>\n`;
  o += `\t\t\t\t\t\t<end>${tlEnd}</end>\n`;
  o += `\t\t\t\t\t\t<in>${srcIn}</in>\n`;
  o += `\t\t\t\t\t\t<out>${srcOut}</out>\n`;
  o += `\t\t\t\t\t\t<pproTicksIn>${ticksIn}</pproTicksIn>\n`;
  o += `\t\t\t\t\t\t<pproTicksOut>${ticksOut}</pproTicksOut>\n`;
  o += `\t\t\t\t\t\t<file id="${fileId}"/>\n`;
  o += `\t\t\t\t\t\t<sourcetrack>\n`;
  o += `\t\t\t\t\t\t\t<mediatype>audio</mediatype>\n`;
  o += `\t\t\t\t\t\t\t<trackindex>${sourceTrack}</trackindex>\n`;
  o += `\t\t\t\t\t\t</sourcetrack>\n`;
  o += `\t\t\t\t\t</clipitem>\n`;
  return o;
}

function writeAudioClipitemWithFile(
  clipId: string, clipName: string, fileId: string, masterclipId: string,
  tlStart: number, tlEnd: number, srcIn: number, srcOut: number,
  duration: number, sourceTrack: number, tl: Timeline,
  pathurl: string, startTc: number, tcStr: string,
  fileName?: string
): string {
  const tpf = ticksPerFrame(tl.timebase, tl.ntsc);
  const ticksIn = srcIn * tpf;
  const ticksOut = srcOut * tpf;

  let o = "";
  o += `\t\t\t\t\t<clipitem id="${clipId}">\n`;
  o += `\t\t\t\t\t\t<masterclipid>${masterclipId}</masterclipid>\n`;
  o += `\t\t\t\t\t\t<name>${escapeXml(clipName)}</name>\n`;
  o += `\t\t\t\t\t\t<enabled>TRUE</enabled>\n`;
  o += `\t\t\t\t\t\t<duration>${duration}</duration>\n`;
  o += writeRate(6, tl.timebase, tl.ntsc);
  o += `\t\t\t\t\t\t<start>${tlStart}</start>\n`;
  o += `\t\t\t\t\t\t<end>${tlEnd}</end>\n`;
  o += `\t\t\t\t\t\t<in>${srcIn}</in>\n`;
  o += `\t\t\t\t\t\t<out>${srcOut}</out>\n`;
  o += `\t\t\t\t\t\t<pproTicksIn>${ticksIn}</pproTicksIn>\n`;
  o += `\t\t\t\t\t\t<pproTicksOut>${ticksOut}</pproTicksOut>\n`;
  o += writeAudioFileDef(fileId, fileName ?? clipName, pathurl, duration, startTc, tcStr, tl);
  o += `\t\t\t\t\t\t<sourcetrack>\n`;
  o += `\t\t\t\t\t\t\t<mediatype>audio</mediatype>\n`;
  o += `\t\t\t\t\t\t\t<trackindex>${sourceTrack}</trackindex>\n`;
  o += `\t\t\t\t\t\t</sourcetrack>\n`;
  o += `\t\t\t\t\t</clipitem>\n`;
  return o;
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

function renderConformXml(
  result: ConformResult,
  beforeClipMarkers: [number, string][],
  afterClipMarkers: [number, string][],
  after: Timeline,
  config: ConformConfig,
  changes: Change[]
): string {
  const { segments, removed } = result;
  const leader = config.leaderFrames;
  const afterContent = filterContentClips(after.clips, config.trackFilter, leader);
  const afterRefStart = leader;
  const afterRefEnd = afterContent.length > 0
    ? afterContent[afterContent.length - 1].end
    : after.duration_frames;

  const startTc = after.start_tc_frames;
  const tcString = framesToTimecodeWithTb(startTc, after.timebase);
  const displayFormat = after.ntsc && after.timebase === 30 ? "DF" : "NDF";
  const tb = after.timebase;
  const ntsc = after.ntsc;

  const beforeRefName = refNameFromPathurl(config.beforeRefPathurl, "before", DEFAULT_BEFORE_REF_NAME);
  const afterRefName = refNameFromPathurl(config.afterRefPathurl, "after", DEFAULT_AFTER_REF_NAME);
  const beforeAudioName = refNameFromPathurl(config.beforeRefAudioPathurl, "before", "Before_Timeline_REF_Audio");
  const afterAudioName = refNameFromPathurl(config.afterRefAudioPathurl, "after", "After_Timeline_REF_Audio");

  let o = "";

  // Header
  o += `<?xml version="1.0" encoding="UTF-8"?>\n`;
  o += `<!DOCTYPE xmeml>\n`;
  o += `<xmeml version="4">\n`;
  o += `\t<sequence id="sequence-1">\n`;
  o += `\t\t<uuid>00000000-0000-0000-0000-000000000001</uuid>\n`;
  o += `\t\t<duration>${after.duration_frames}</duration>\n`;
  o += writeRate(2, tb, ntsc);
  o += `\t\t<name>${escapeXml(config.sequenceName)}</name>\n`;
  o += `\t\t<media>\n`;

  // Video
  o += `\t\t\t<video>\n`;
  o += writeVideoFormat(after);

  // Build after segments, sub-divided at each change's timecode so every
  // change gets its own clip on the timeline with an annotated name.
  const afterSegments: { tlStart: number; tlEnd: number; srcIn: number; srcOut: number; clipName: string }[] = [];
  for (const c of afterContent) {
    // Collect change timecodes that fall strictly inside this clip (not at boundaries)
    const cutPoints = changes
      .filter(ch => ch.timecode_frames > c.start && ch.timecode_frames < c.end)
      .map(ch => ch.timecode_frames);
    // Deduplicate and sort
    const uniqueCuts = [...new Set(cutPoints)].sort((a, b) => a - b);

    const boundaries = [c.start, ...uniqueCuts, c.end];
    for (let k = 0; k < boundaries.length - 1; k++) {
      const segStart = boundaries[k];
      const segEnd = boundaries[k + 1];
      // Find changes at or within this sub-segment
      const matching = changes.filter(
        ch => ch.timecode_frames >= segStart && ch.timecode_frames < segEnd
      );
      const label = matching.length > 0
        ? `${c.name} /// ${matching.map(ch => `${ch.description} | ${framesToDeltaTimecode(ch.delta_frames)}`).join(" /// ")}`
        : c.name;
      afterSegments.push({
        tlStart: segStart,
        tlEnd: segEnd,
        srcIn: segStart,
        srcOut: segEnd,
        clipName: label,
      });
    }
  }

  // V1: After ref — segmented at edit points
  o += `\t\t\t\t<track MZ.TrackName="V1 - After REF">\n`;
  for (let i = 0; i < afterSegments.length; i++) {
    const seg = afterSegments[i];
    const clipId = `clipitem-after-${i + 1}`;
    // Distribute markers to the segment containing them
    const segMarkers: [number, string][] = afterClipMarkers.filter(
      ([frame]) => frame >= seg.srcIn && frame < seg.srcOut
    );
    o += writeClipitemWithSourceMarkers(
      clipId, seg.clipName, "file-after", "masterclip-after",
      seg.tlStart, seg.tlEnd, seg.srcIn, seg.srcOut,
      config.afterRefDuration, null,
      i === 0 ? { pathurl: config.afterRefPathurl, startTc, tcStr: tcString, fileName: afterRefName } : null,
      after, segMarkers
    );
  }
  o += `\t\t\t\t</track>\n`;

  // V2: Before ref segments with opacity
  o += `\t\t\t\t<track MZ.TrackName="V2 - Before REF">\n`;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const clipId = `clipitem-${i + 1}`;
    const markers: [number, string][] = i === 0 ? beforeClipMarkers : [];
    o += writeClipitemWithSourceMarkers(
      clipId, beforeRefName, "file-before", "masterclip-before",
      seg.tlStart, seg.tlEnd, seg.srcIn, seg.srcOut,
      config.beforeRefDuration, config.opacity,
      i === 0 ? { pathurl: config.beforeRefPathurl, startTc, tcStr: tcString } : null,
      after, markers
    );
  }
  o += `\t\t\t\t</track>\n`;

  // V3+: Removed/trimmed clips (disabled) spread across lanes
  if (removed.length > 0) {
    const lanes: ConformSegment[][] = [];
    for (const seg of removed) {
      let placed = false;
      for (const lane of lanes) {
        const lastEnd = lane.length > 0 ? lane[lane.length - 1].tlEnd : 0;
        if (seg.tlStart >= lastEnd) {
          lane.push(seg);
          placed = true;
          break;
        }
      }
      if (!placed) {
        lanes.push([seg]);
      }
    }

    for (let laneIdx = 0; laneIdx < lanes.length; laneIdx++) {
      const trackNum = 3 + laneIdx;
      o += `\t\t\t\t<track MZ.TrackName="V${trackNum} - Removed" TL.SQTrackShy="0">\n`;
      for (let i = 0; i < lanes[laneIdx].length; i++) {
        const seg = lanes[laneIdx][i];
        const clipId = `clipitem-removed-${laneIdx}-${i + 1}`;
        o += writeDisabledClipitem(
          clipId, beforeRefName, "file-before", "masterclip-before",
          seg.tlStart, seg.tlEnd, seg.srcIn, seg.srcOut,
          config.beforeRefDuration, after
        );
      }
      o += `\t\t\t\t</track>\n`;
    }
  }

  o += `\t\t\t</video>\n`;

  // Audio
  o += `\t\t\t<audio>\n`;
  o += `\t\t\t\t<numOutputChannels>2</numOutputChannels>\n`;
  o += `\t\t\t\t<format>\n`;
  o += `\t\t\t\t\t<samplecharacteristics>\n`;
  o += `\t\t\t\t\t\t<depth>16</depth>\n`;
  o += `\t\t\t\t\t\t<samplerate>48000</samplerate>\n`;
  o += `\t\t\t\t\t</samplecharacteristics>\n`;
  o += `\t\t\t\t</format>\n`;

  // A1: After ref audio — segmented to match V1
  o += `\t\t\t\t<track MZ.TrackName="A1 - After REF">\n`;
  for (let i = 0; i < afterSegments.length; i++) {
    const seg = afterSegments[i];
    const clipId = `clipitem-audio-after-${i + 1}`;
    if (i === 0) {
      o += writeAudioClipitemWithFile(
        clipId, seg.clipName, "file-after-audio", "masterclip-after-audio",
        seg.tlStart, seg.tlEnd, seg.srcIn, seg.srcOut,
        config.afterRefDuration, 1, after,
        config.afterRefAudioPathurl, startTc, tcString,
        afterAudioName
      );
    } else {
      o += writeAudioClipitem(
        clipId, seg.clipName, "file-after-audio", "masterclip-after-audio",
        seg.tlStart, seg.tlEnd, seg.srcIn, seg.srcOut,
        config.afterRefDuration, 1, after
      );
    }
  }
  o += `\t\t\t\t</track>\n`;

  // A2: Before ref audio segments
  o += `\t\t\t\t<track MZ.TrackName="A2 - Before REF">\n`;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const clipId = `clipitem-audio-before-${i + 1}`;
    if (i === 0) {
      o += writeAudioClipitemWithFile(
        clipId, beforeAudioName, "file-before-audio", "masterclip-before-audio",
        seg.tlStart, seg.tlEnd, seg.srcIn, seg.srcOut,
        config.beforeRefDuration, 1, after,
        config.beforeRefAudioPathurl, startTc, tcString
      );
    } else {
      o += writeAudioClipitem(
        clipId, beforeAudioName, "file-before-audio", "masterclip-before-audio",
        seg.tlStart, seg.tlEnd, seg.srcIn, seg.srcOut,
        config.beforeRefDuration, 1, after
      );
    }
  }
  o += `\t\t\t\t</track>\n`;

  o += `\t\t\t</audio>\n`;
  o += `\t\t</media>\n`;

  // Sequence markers
  const markers = buildMarkers(changes);
  for (const marker of markers) {
    o += `\t\t<marker>\n`;
    o += `\t\t\t<comment>${escapeXml(marker.comment)}</comment>\n`;
    o += `\t\t\t<name>${escapeXml(marker.name)}</name>\n`;
    o += `\t\t\t<in>${marker.frame}</in>\n`;
    o += `\t\t\t<out>${marker.outFrame}</out>\n`;
    o += `\t\t\t<pproColor>${marker.color}</pproColor>\n`;
    o += `\t\t</marker>\n`;
  }

  // Timecode
  o += `\t\t<timecode>\n`;
  o += writeRate(3, tb, ntsc);
  o += `\t\t\t<string>${tcString}</string>\n`;
  o += `\t\t\t<frame>${startTc}</frame>\n`;
  o += `\t\t\t<displayformat>${displayFormat}</displayformat>\n`;
  o += `\t\t</timecode>\n`;

  o += `\t</sequence>\n`;
  o += `</xmeml>\n`;

  return o;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function generateConformXml(
  before: Timeline,
  after: Timeline,
  changes: Change[],
  config: ConformConfig
): string {
  const result = computeConformSegments(before, after, config);
  const leader = config.leaderFrames;

  const beforeClipMarkers: [number, string][] = filterContentClips(before.clips, config.trackFilter, leader)
    .map(c => [c.start, c.name]);
  const afterClipMarkers: [number, string][] = filterContentClips(after.clips, config.trackFilter, leader)
    .map(c => [c.start, c.name]);

  return renderConformXml(result, beforeClipMarkers, afterClipMarkers, after, config, changes);
}
