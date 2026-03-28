// Ported from marker_converter.rs

import { parseFcpXml, stripDoctype } from "./xmlParser";
import type { CsvConfig, CsvRow } from "./csvGenerator";
import { writeCsv } from "./csvGenerator";
import { framesToDisplayTimecodeWithTb, sceneFromName } from "./timeline";

interface ParsedMarker {
  frame: number;
  name: string;
  comment: string;
  color: string;
}

export function markersToCsv(
  xmlContent: string,
  config: CsvConfig,
): { rows: CsvRow[]; csv: string } {
  const cleaned = stripDoctype(xmlContent);
  const parser = new DOMParser();
  const doc = parser.parseFromString(cleaned, "application/xml");

  const parseError = doc.querySelector("parsererror");
  if (parseError) throw new Error(`XML parse error: ${parseError.textContent}`);

  const root = doc.documentElement;
  const sequence = findElement(root, "sequence");
  if (!sequence) throw new Error("No <sequence> element found");

  const timebase = findRateTimebase(sequence);
  const startTcFrames = parseStartTc(sequence);

  const markers: ParsedMarker[] = [];
  for (const child of Array.from(sequence.children)) {
    if (child.tagName === "marker") {
      const frame = parseInt(getChildText(child, "in") ?? "0", 10) || 0;
      const name = getChildText(child, "name") ?? "";
      const comment = getChildText(child, "comment") ?? "";
      const color = getChildText(child, "pproColor") ?? "";
      markers.push({ frame, name, comment, color });
    }
  }

  markers.sort((a, b) => a.frame - b.frame);

  const rows: CsvRow[] = [];
  let rowId = 0;
  let lastScene = "";
  let lastTc = "";

  for (const marker of markers) {
    const { tc, description, delta, clipName, scene } = parseMarkerComment(
      marker.comment,
      marker.frame,
      startTcFrames,
      timebase,
    );

    // Parse counter from marker name (e.g. "#3") if present; user-added markers get 0
    const counterMatch = marker.name.match(/^#(\d+)$/);
    const counter = counterMatch ? parseInt(counterMatch[1], 10) : 0;

    const sceneDisplay = scene && scene !== lastScene ? (lastScene = scene, scene) : "";
    const tcDisplay = tc !== lastTc ? (lastTc = tc, tc) : "";
    const { confidence, confidence_label } = colorToConfidence(marker.color);

    rows.push({
      counter,
      scene: sceneDisplay,
      timecode: tcDisplay,
      description,
      delta,
      confidence,
      confidence_label,
      is_summary: false,
      clip_name: clipName,
      row_id: rowId++,
    });
  }

  const csv = writeCsv(rows, config);
  return { rows, csv };
}

function parseMarkerComment(
  comment: string,
  frame: number,
  startTcFrames: number,
  timebase: number,
): { tc: string; description: string; delta: string; clipName: string; scene: string } {
  const tc = framesToDisplayTimecodeWithTb(frame, startTcFrames, timebase);
  const parts = comment.split("|").map((s) => s.trim());

  const hasLeadingTc =
    parts.length >= 4 &&
    parts[0].length >= 11 &&
    (parts[0].match(/:/g) ?? []).length === 3;

  if (hasLeadingTc) {
    const description = parts[1];
    const delta = parts[2];
    const clipName = parts[3];
    return { tc, description, delta, clipName, scene: sceneFromName(clipName) };
  } else if (parts.length >= 3) {
    const description = parts[0];
    const delta = parts[1];
    const clipName = parts[2];
    return { tc, description, delta, clipName, scene: sceneFromName(clipName) };
  } else if (parts.length === 2) {
    const description = parts[0];
    const deltaOrClip = parts[1];
    if (deltaOrClip.startsWith("+") || deltaOrClip.startsWith("-")) {
      return { tc, description, delta: deltaOrClip, clipName: "", scene: "" };
    }
    return { tc, description, delta: "", clipName: deltaOrClip, scene: sceneFromName(deltaOrClip) };
  }

  return { tc, description: comment, delta: "", clipName: "", scene: "" };
}

function colorToConfidence(color: string): { confidence: number; confidence_label: string } {
  switch (color) {
    case "4278255360": return { confidence: 95, confidence_label: "High" };   // Green
    case "4294967040": return { confidence: 75, confidence_label: "Medium" }; // Yellow
    case "4294901760": return { confidence: 45, confidence_label: "Low" };    // Red
    case "4278190335": return { confidence: 95, confidence_label: "High" };   // Blue
    case "4278255615": return { confidence: 95, confidence_label: "High" };   // Cyan
    default: return { confidence: 0, confidence_label: "" };
  }
}

function findElement(node: Element, tag: string): Element | null {
  for (const child of Array.from(node.children)) {
    if (child.tagName === tag) return child;
    const found = findElement(child, tag);
    if (found) return found;
  }
  return null;
}

function getChildText(node: Element, tag: string): string | null {
  for (const child of Array.from(node.children)) {
    if (child.tagName === tag) return child.textContent?.trim() ?? "";
  }
  return null;
}

function findRateTimebase(sequence: Element): number {
  const rate = findElement(sequence, "rate");
  if (!rate) return 24;
  return parseInt(getChildText(rate, "timebase") ?? "24", 10) || 24;
}

function parseStartTc(sequence: Element): number {
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
