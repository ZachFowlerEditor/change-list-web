// Ported from csv_generator.rs

import type { Change, ChangeGroup } from "./changeDetector";
import { confidenceScore, confidenceLabel } from "./changeDetector";
import { framesToDisplayTimecode, framesToDeltaTimecode, framesToTimecode } from "./timeline";

export type OutputMode = "individual" | "grouped" | "both";

export interface CsvConfig {
  project_name: string;
  version_date: string;
  reel_name: string;
  mode: OutputMode;
}

export interface CsvRow {
  scene: string;
  timecode: string;
  description: string;
  delta: string;
  confidence: number;
  confidence_label: string;
  is_summary: boolean;
  clip_name: string;
  row_id: number;
}

export function generateRows(
  changes: Change[],
  groups: ChangeGroup[],
  config: CsvConfig,
  startTcFrames: number,
): CsvRow[] {
  const rows: CsvRow[] = [];
  let rowId = 0;

  if (config.mode === "individual") {
    let lastScene = "";
    let lastTc = "";
    for (const change of changes) {
      const sceneDisplay = change.scene !== lastScene ? (lastScene = change.scene, change.scene) : "";
      const tc = framesToDisplayTimecode(change.timecode_frames, startTcFrames);
      const tcDisplay = tc !== lastTc ? (lastTc = tc, tc) : "";
      rows.push({
        scene: sceneDisplay,
        timecode: tcDisplay,
        description: change.description,
        delta: framesToDeltaTimecode(change.delta_frames),
        confidence: confidenceScore(change.confidence),
        confidence_label: confidenceLabel(change.confidence),
        is_summary: false,
        clip_name: change.clip_name,
        row_id: rowId++,
      });
    }
  } else if (config.mode === "grouped") {
    let lastScene = "";
    for (const group of groups) {
      const sceneDisplay = group.scene !== lastScene ? (lastScene = group.scene, group.scene) : "";
      const tc = framesToDisplayTimecode(group.timecode_frames, startTcFrames);

      if (group.is_re_edit) {
        const totalDelta = framesToDeltaTimecode(group.total_delta_frames);
        const avgConf = group.changes.length
          ? Math.round(group.changes.reduce((s, c) => s + confidenceScore(c.confidence), 0) / group.changes.length)
          : 0;
        rows.push({
          scene: sceneDisplay,
          timecode: tc,
          description: `Sequence re-edited. ${group.total_delta_frames >= 0 ? "Added" : "Removed"} ${framesToTimecode(Math.abs(group.total_delta_frames))} in total`,
          delta: totalDelta,
          confidence: avgConf,
          confidence_label: confLabelFromScore(avgConf),
          is_summary: true,
          clip_name: "",
          row_id: rowId++,
        });
        for (const change of group.changes) {
          rows.push({
            scene: "",
            timecode: "",
            description: change.description,
            delta: "",
            confidence: confidenceScore(change.confidence),
            confidence_label: confidenceLabel(change.confidence),
            is_summary: false,
            clip_name: change.clip_name,
            row_id: rowId++,
          });
        }
      } else {
        let first = true;
        for (const change of group.changes) {
          rows.push({
            scene: first ? sceneDisplay : "",
            timecode: first ? tc : "",
            description: change.description,
            delta: framesToDeltaTimecode(change.delta_frames),
            confidence: confidenceScore(change.confidence),
            confidence_label: confidenceLabel(change.confidence),
            is_summary: false,
            clip_name: change.clip_name,
            row_id: rowId++,
          });
          first = false;
        }
      }
    }
  } else {
    // both
    let lastScene = "";
    let lastTc = "";
    for (const change of changes) {
      const sceneDisplay = change.scene !== lastScene ? (lastScene = change.scene, change.scene) : "";
      const tc = framesToDisplayTimecode(change.timecode_frames, startTcFrames);
      const tcDisplay = tc !== lastTc ? (lastTc = tc, tc) : "";
      rows.push({
        scene: sceneDisplay,
        timecode: tcDisplay,
        description: change.description,
        delta: framesToDeltaTimecode(change.delta_frames),
        confidence: confidenceScore(change.confidence),
        confidence_label: confidenceLabel(change.confidence),
        is_summary: false,
        clip_name: change.clip_name,
        row_id: rowId++,
      });
    }
  }

  return rows;
}

export function writeCsv(rows: CsvRow[], config: CsvConfig): string {
  const lines: string[] = [];
  lines.push(`"${config.project_name} - Change List`);
  lines.push(`     Version Date: ${config.version_date}",,`);
  lines.push(",,,");
  lines.push(`Scene,${config.reel_name} TC,Description,+/- Frames,Confidence,Clip`);
  lines.push(`${config.reel_name},,,,`);

  for (const row of rows) {
    const scene = escapeCsv(row.scene);
    const tc = escapeCsv(row.timecode);
    const desc = escapeCsv(row.description);
    const delta = escapeCsv(row.delta);
    const conf = row.confidence > 0 ? `${row.confidence}%` : "";
    const clip = escapeCsv(row.clip_name);
    lines.push(`${scene},${tc},${desc},${delta},${conf},${clip}`);
  }

  return lines.join("\n");
}

function escapeCsv(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function confLabelFromScore(score: number): string {
  if (score >= 90) return "High";
  if (score >= 60) return "Medium";
  return "Low";
}

export function csvToTsv(csvContent: string): string {
  const lines = csvContent.split("\n");
  const dataLines = lines.slice(5);
  return dataLines
    .map((line) => {
      const fields: string[] = [];
      let current = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
          else { inQuotes = !inQuotes; }
        } else if (ch === "," && !inQuotes) {
          fields.push(current); current = "";
        } else {
          current += ch;
        }
      }
      fields.push(current);
      return fields.map((f) => (/^[+\-]\d/.test(f) ? "'" + f : f)).join("\t");
    })
    .join("\n");
}
