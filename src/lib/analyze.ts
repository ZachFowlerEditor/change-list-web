// Replaces Tauri command handlers — pure TypeScript

import { parseFcpXml } from "./xmlParser";
import { detectChanges, groupChanges, computeAnalysisStats, DEFAULT_LEADER_FRAMES } from "./changeDetector";
import { generateRows, writeCsv, type CsvConfig, type CsvRow, type OutputMode } from "./csvGenerator";
import { markersToCsv } from "./markerConverter";
import { framesToTimecode, framesToDeltaTimecode } from "./timeline";

export interface AnalysisStats {
  trims: number;
  shots_added: number;
  shots_removed: number;
  shots_replaced: number;
  camera_swaps: number;
  edit_shifts: number;
  jump_cuts: number;
}

export interface AnalysisResult {
  rows: CsvRow[];
  csv_content: string;
  before_clip_count: number;
  after_clip_count: number;
  before_name: string;
  after_name: string;
  total_changes: number;
  after_start_tc_frames: number;
  before_duration_frames: number;
  after_duration_frames: number;
  before_duration_tc: string;
  after_duration_tc: string;
  net_trt_frames: number;
  net_trt_tc: string;
  stats: AnalysisStats;
}

export function analyzeXmls(params: {
  beforeContent: string;
  afterContent: string;
  project_name: string;
  version_date: string;
  reel_name: string;
  mode: string;
}): AnalysisResult {
  const before = parseFcpXml(params.beforeContent);
  const after = parseFcpXml(params.afterContent);

  const changes = detectChanges(before, after);
  const groups = groupChanges(changes);

  const outputMode: OutputMode =
    params.mode === "individual" ? "individual" : params.mode === "grouped" ? "grouped" : "both";

  const config: CsvConfig = {
    project_name: params.project_name || "Change List",
    version_date: params.version_date || todayDate(),
    reel_name: params.reel_name || "Reel 1",
    mode: outputMode,
  };

  const rows = generateRows(changes, groups, config, after.start_tc_frames);
  const csv_content = writeCsv(rows, config);
  const stats = computeAnalysisStats(changes);

  const beforeLastFrame =
    before.clips
      .filter((c) => c.enabled && c.start >= DEFAULT_LEADER_FRAMES)
      .reduce((max, c) => Math.max(max, c.end), 0) || before.duration_frames;
  const afterLastFrame =
    after.clips
      .filter((c) => c.enabled && c.start >= DEFAULT_LEADER_FRAMES)
      .reduce((max, c) => Math.max(max, c.end), 0) || after.duration_frames;

  const net_trt_frames = afterLastFrame - beforeLastFrame;

  return {
    rows,
    csv_content,
    before_clip_count: before.clips.length,
    after_clip_count: after.clips.length,
    before_name: before.name,
    after_name: after.name,
    total_changes: changes.length,
    after_start_tc_frames: after.start_tc_frames,
    before_duration_frames: beforeLastFrame,
    after_duration_frames: afterLastFrame,
    before_duration_tc: framesToTimecode(beforeLastFrame),
    after_duration_tc: framesToTimecode(afterLastFrame),
    net_trt_frames,
    net_trt_tc: framesToDeltaTimecode(net_trt_frames),
    stats,
  };
}

export function convertMarkersToResult(params: {
  xmlContent: string;
  project_name: string;
  version_date: string;
  reel_name: string;
}): AnalysisResult {
  const config: CsvConfig = {
    project_name: params.project_name || "Change List",
    version_date: params.version_date || todayDate(),
    reel_name: params.reel_name || "Reel 1",
    mode: "individual",
  };

  const { rows, csv } = markersToCsv(params.xmlContent, config);

  return {
    rows,
    csv_content: csv,
    before_clip_count: 0,
    after_clip_count: 0,
    before_name: "",
    after_name: "Markers",
    total_changes: rows.length,
    after_start_tc_frames: 0,
    before_duration_frames: 0,
    after_duration_frames: 0,
    before_duration_tc: "",
    after_duration_tc: "",
    net_trt_frames: 0,
    net_trt_tc: "",
    stats: {
      trims: 0, shots_added: 0, shots_removed: 0, shots_replaced: 0,
      camera_swaps: 0, edit_shifts: 0, jump_cuts: 0,
    },
  };
}

export function exportCsvFiltered(params: {
  rows: CsvRow[];
  configJson: string;
}): string {
  const config: CsvConfig & { mode: string } = JSON.parse(params.configJson);
  const modeStr = typeof config.mode === "string" ? config.mode.toLowerCase() : "both";
  const csvConfig: CsvConfig = {
    ...config,
    mode: modeStr === "individual" ? "individual" : modeStr === "grouped" ? "grouped" : "both",
  };
  return writeCsv(params.rows, csvConfig);
}

function todayDate(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}
