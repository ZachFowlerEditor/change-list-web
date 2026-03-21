// Ported from xml_parser.rs — uses browser DOMParser instead of roxmltree

import type { Clip, Timeline } from "./timeline";

export function parseFcpXml(xmlContent: string): Timeline {
  const cleaned = stripDoctype(xmlContent);
  const parser = new DOMParser();
  const doc = parser.parseFromString(cleaned, "application/xml");

  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    throw new Error(`XML parse error: ${parseError.textContent}`);
  }

  const sequence = findElement(doc.documentElement, "sequence");
  if (!sequence) throw new Error("No <sequence> element found");

  const name = getChildText(sequence, "name") ?? "";
  const duration_frames = parseInt(getChildText(sequence, "duration") ?? "0", 10) || 0;

  const { timebase, ntsc } = parseRate(sequence);
  const start_tc_frames = parseTimelineTimecode(sequence);
  const { width, height } = parseResolution(sequence);

  let clips: Clip[] = [];
  const media = findElement(sequence, "media");
  if (media) {
    const video = findElement(media, "video");
    if (video) {
      let trackIndex = 0;
      const tracks = Array.from(video.children).filter((n) => n.tagName === "track");
      for (const track of tracks) {
        trackIndex++;

        // Collect transitions on this track
        const transitions: Array<[number, number]> = Array.from(track.children)
          .filter((n) => n.tagName === "transitionitem")
          .map((t) => {
            const start = parseInt(getChildText(t, "start") ?? "-1", 10);
            const end = parseInt(getChildText(t, "end") ?? "-1", 10);
            return [start, end] as [number, number];
          })
          .filter(([s, e]) => s >= 0 && e >= 0);

        const clipitems = Array.from(track.children).filter((n) => n.tagName === "clipitem");
        for (const clipitem of clipitems) {
          const clip = parseClipitem(clipitem);
          if (!clip) continue;
          clip.track_index = trackIndex;

          // Adjust for transitions
          const clipDur = clip.end - clip.start;
          for (const [tStart, tEnd] of transitions) {
            const tDur = tEnd - tStart;
            const tHalf = Math.floor(tDur / 2);

            if (Math.abs(tEnd - clip.start) <= 1 && tHalf > 0) {
              if (clipDur > tHalf * 2) {
                clip.source_in += tHalf;
                clip.start += tHalf;
              }
            }
            if (Math.abs(tStart - clip.end) <= 1 && tHalf > 0) {
              if (clipDur > tHalf * 2) {
                clip.source_out -= tHalf;
                clip.end -= tHalf;
              }
            }
          }

          if (clip.start < clip.end && clip.source_in < clip.source_out) {
            clips.push(clip);
          }
        }
      }
    }
  }

  clips.sort((a, b) => a.start - b.start);
  clips = mergeThroughEdits(clips);

  return { name, duration_frames, start_tc_frames, timebase, ntsc, width, height, clips };
}

function parseRate(parent: Element): { timebase: number; ntsc: boolean } {
  const rate = findElement(parent, "rate");
  if (!rate) return { timebase: 24, ntsc: false };
  const timebase = parseInt(getChildText(rate, "timebase") ?? "24", 10) || 24;
  const ntsc = getChildText(rate, "ntsc") === "TRUE";
  return { timebase, ntsc };
}

function parseResolution(sequence: Element): { width: number; height: number } {
  const media = findElement(sequence, "media");
  if (!media) return { width: 1920, height: 1080 };
  const video = findElement(media, "video");
  if (!video) return { width: 1920, height: 1080 };
  const format = findElement(video, "format");
  if (!format) return { width: 1920, height: 1080 };
  const sc = findElement(format, "samplecharacteristics");
  if (!sc) return { width: 1920, height: 1080 };
  const width = parseInt(getChildText(sc, "width") ?? "1920", 10) || 1920;
  const height = parseInt(getChildText(sc, "height") ?? "1080", 10) || 1080;
  return { width, height };
}

function parseTimelineTimecode(sequence: Element): number {
  for (const child of Array.from(sequence.children)) {
    if (child.tagName === "timecode") {
      const frame = getChildText(child, "frame");
      if (frame) {
        const f = parseInt(frame, 10);
        if (!isNaN(f)) return f;
      }
    }
  }
  return 0;
}

function parseClipitem(node: Element): Clip | null {
  const id = node.getAttribute("id") ?? "";
  const name = getChildText(node, "name") ?? "";
  const enabled = getChildText(node, "enabled") !== "FALSE";

  const start = parseInt(getChildText(node, "start") ?? "0", 10) || 0;
  const end = parseInt(getChildText(node, "end") ?? "0", 10) || 0;
  const source_in = parseInt(getChildText(node, "in") ?? "0", 10) || 0;
  const source_out = parseInt(getChildText(node, "out") ?? "0", 10) || 0;
  const source_duration = parseInt(getChildText(node, "duration") ?? "0", 10) || 0;
  const master_clip_id = getChildText(node, "masterclipid") ?? "";

  let scene = "";
  let shot_take = "";
  const logging = findElement(node, "logginginfo");
  if (logging) {
    scene = getChildText(logging, "scene") ?? "";
    shot_take = getChildText(logging, "shottake") ?? "";
  }

  const source_file = extractSourceFile(node);

  if (start < 0 || end <= start) return null;

  return {
    id, name, scene, shot_take, source_file, master_clip_id,
    start, end, source_in, source_out, source_duration,
    enabled, track_index: 0,
  };
}

function extractSourceFile(clipitem: Element): string {
  const fileNode = findElement(clipitem, "file");
  if (!fileNode) return "";
  const pathurl = getChildText(fileNode, "pathurl");
  if (pathurl) return pathurl;
  const fname = getChildText(fileNode, "name");
  return fname ?? "";
}

function mergeThroughEdits(clips: Clip[]): Clip[] {
  if (clips.length < 2) return clips;

  clips.sort((a, b) => a.track_index !== b.track_index ? a.track_index - b.track_index : a.start - b.start);

  const merged: Clip[] = [];
  let i = 0;
  while (i < clips.length) {
    let current = { ...clips[i] };
    while (i + 1 < clips.length && isThroughEdit(current, clips[i + 1])) {
      const next = clips[i + 1];
      current.end = next.end;
      current.source_out = next.source_out;
      if (next.source_duration > current.source_duration) {
        current.source_duration = next.source_duration;
      }
      i++;
    }
    merged.push(current);
    i++;
  }

  merged.sort((a, b) => a.start - b.start);
  return merged;
}

function isThroughEdit(a: Clip, b: Clip): boolean {
  if (a.track_index !== b.track_index) return false;

  const sameSource = (a.name && a.name === b.name) ||
    (a.master_clip_id && a.master_clip_id === b.master_clip_id &&
      a.source_file && a.source_file === b.source_file);

  if (!sameSource) return false;

  const timelineAdjacent = Math.abs(a.end - b.start) <= 1;
  const sourceContinuous = Math.abs(a.source_out - b.source_in) <= 1;

  return timelineAdjacent && sourceContinuous;
}

/** Recursively find first descendant element with given tag name */
function findElement(node: Element | Document, tag: string): Element | null {
  const root = node instanceof Document ? node.documentElement : node;
  for (const child of Array.from(root.children)) {
    if (child.tagName === tag) return child;
    const found = findElement(child, tag);
    if (found) return found;
  }
  return null;
}

/** Get direct child element's text content */
function getChildText(node: Element, tag: string): string | null {
  for (const child of Array.from(node.children)) {
    if (child.tagName === tag) {
      return child.textContent?.trim() ?? "";
    }
  }
  return null;
}

export function stripDoctype(xml: string): string {
  // Strip BOM
  let s = xml.replace(/^\uFEFF/, "");
  // Remove DOCTYPE lines
  s = s.split("\n").filter((line) => !line.trimStart().startsWith("<!DOCTYPE")).join("\n");
  return s;
}
