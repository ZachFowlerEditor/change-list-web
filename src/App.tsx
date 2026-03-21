import React, { useState, useEffect, useRef } from "react";
import { analyzeXmls, convertMarkersToResult, exportCsvFiltered } from "./lib/analyze";
import { csvToTsv } from "./lib/csvGenerator";
import type { AnalysisResult } from "./lib/analyze";
import type { CsvRow } from "./lib/csvGenerator";

interface ReelStats {
  reel_name: string;
  project_name: string;
  version: string;
  last_converted: string;
  before_file: string;
  after_file: string;
  before_clips: number;
  after_clips: number;
  total_changes: number;
  trims: number;
  shots_added: number;
  shots_removed: number;
  shots_replaced: number;
  camera_swaps: number;
  edit_shifts: number;
  jump_cuts: number;
  net_delta_frames: number;
  net_delta_tc: string;
}

function framesToDeltaTc(frames: number): string {
  if (frames === 0) return "00:00:00:00";
  const abs = Math.abs(frames);
  const ff = abs % 24;
  const s = Math.floor(abs / 24) % 60;
  const m = Math.floor(abs / (24 * 60)) % 60;
  const h = Math.floor(abs / (24 * 60 * 60));
  const tc = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(ff).padStart(2, "0")}`;
  return frames > 0 ? `+${tc}` : `-${tc}`;
}

/** Read a File as text */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

/** Trigger a file download */
function downloadFile(content: string, filename: string, mimeType = "text/csv") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Hidden file input helper */
function openFileDialog(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

// ---- Analytics Panel ----

function AnalyticsPanel({
  result, analytics, onUpdate, reelName, projectName, versionDate, beforeName, afterName,
}: {
  result: AnalysisResult;
  analytics: ReelStats[];
  onUpdate: (updated: ReelStats[]) => void;
  reelName: string;
  projectName: string;
  versionDate: string;
  beforeName: string;
  afterName: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [infoEntry, setInfoEntry] = useState<ReelStats | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);

  const projectNames = Array.from(new Set(analytics.map((e) => e.project_name).filter(Boolean))).sort();
  const [activeTab, setActiveTab] = useState<string>(projectName || "All");

  const updateEntry = (idx: number, field: keyof ReelStats, value: string) => {
    const updated = [...analytics];
    (updated[idx] as any)[field] = value;
    onUpdate(updated);
    try { localStorage.setItem("clt_analytics", JSON.stringify(updated)); } catch {}
  };

  const confirmDelete = () => {
    if (pendingDelete === null) return;
    const updated = analytics.filter((_, i) => i !== pendingDelete);
    onUpdate(updated);
    try { localStorage.setItem("clt_analytics", JSON.stringify(updated)); } catch {}
    setPendingDelete(null);
  };

  const toggle = (reel: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(reel)) next.delete(reel); else next.add(reel);
      return next;
    });
  };

  const currentEntry: ReelStats = {
    reel_name: reelName || "Current",
    project_name: projectName || "",
    version: versionDate || "",
    last_converted: "now",
    before_file: beforeName,
    after_file: afterName,
    before_clips: result.before_clip_count,
    after_clips: result.after_clip_count,
    total_changes: result.total_changes,
    trims: result.stats.trims,
    shots_added: result.stats.shots_added,
    shots_removed: result.stats.shots_removed,
    shots_replaced: result.stats.shots_replaced,
    camera_swaps: result.stats.camera_swaps,
    edit_shifts: result.stats.edit_shifts,
    jump_cuts: result.stats.jump_cuts,
    net_delta_frames: result.net_trt_frames,
    net_delta_tc: result.net_trt_tc,
  };

  const filteredAnalytics = activeTab === "All" ? analytics : analytics.filter((e) => e.project_name === activeTab);
  const showCurrent = activeTab === "All" || currentEntry.project_name === activeTab || !currentEntry.project_name;
  const allEntries = [...(showCurrent ? [currentEntry] : []), ...filteredAnalytics];

  type EntryItem = { entry: ReelStats; idx: number; isCurrent: boolean };
  const grouped: Record<string, EntryItem[]> = {};
  for (let i = 0; i < allEntries.length; i++) {
    const entry = allEntries[i];
    const isCurrent = showCurrent && i === 0;
    const analyticsIdx = isCurrent ? -1 : analytics.indexOf(entry);
    const key = entry.reel_name.replace(/ \(markers\)$/, "");
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({ entry, idx: analyticsIdx, isCurrent });
  }
  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => {
      if (a.isCurrent) return -1;
      if (b.isCurrent) return 1;
      return b.entry.last_converted.localeCompare(a.entry.last_converted);
    });
  }
  const reelNamesSorted = Object.keys(grouped).sort();

  const latestPerReel = reelNamesSorted.map((r) => grouped[r][0].entry);
  const totals = {
    total_changes: latestPerReel.reduce((s, e) => s + e.total_changes, 0),
    trims: latestPerReel.reduce((s, e) => s + e.trims, 0),
    shots_added: latestPerReel.reduce((s, e) => s + e.shots_added, 0),
    shots_removed: latestPerReel.reduce((s, e) => s + e.shots_removed, 0),
    shots_replaced: latestPerReel.reduce((s, e) => s + e.shots_replaced, 0),
    camera_swaps: latestPerReel.reduce((s, e) => s + e.camera_swaps, 0),
    edit_shifts: latestPerReel.reduce((s, e) => s + e.edit_shifts, 0),
    jump_cuts: latestPerReel.reduce((s, e) => s + e.jump_cuts, 0),
    net_delta_frames: latestPerReel.reduce((s, e) => s + e.net_delta_frames, 0),
  };

  const renderRow = (item: EntryItem, showReel: boolean, reelKey: string, groupSize: number, isHistory: boolean) => {
    const e = item.entry;
    const isExp = expanded.has(reelKey);
    return (
      <tr
        key={item.isCurrent ? `current-${reelKey}` : `${e.reel_name}-${e.last_converted}-${item.idx}`}
        className={[item.isCurrent ? "current-row" : "", isHistory ? "history-row" : ""].join(" ")}
      >
        <td>
          <button className="toggle-btn info-btn" onClick={() => setInfoEntry(e)} title="Run details">i</button>
          {!item.isCurrent && (
            <button className="toggle-btn delete-btn" onClick={() => setPendingDelete(item.idx)} title="Delete entry">✕</button>
          )}
        </td>
        {showReel && groupSize > 1 ? (
          <td style={{ color: "var(--accent)", fontWeight: 600, cursor: "pointer" }} onClick={() => toggle(reelKey)}>
            {isExp ? "- " : "+ "}{e.reel_name}
            <span style={{ color: "var(--text-dim)", fontWeight: 400, fontSize: 10 }}> ({groupSize})</span>
          </td>
        ) : showReel && item.isCurrent ? (
          <td style={{ color: "var(--accent)", fontWeight: 600 }}>{e.reel_name}</td>
        ) : showReel ? (
          <EditableCell value={e.reel_name} className="scene" onChange={(v) => updateEntry(item.idx, "reel_name", v)} />
        ) : item.isCurrent ? (
          <td style={{ paddingLeft: 24, color: "var(--text-dim)" }}>{e.reel_name}</td>
        ) : (
          <EditableCell value={e.reel_name} style={{ paddingLeft: 24, color: "var(--text-dim)" }} onChange={(v) => updateEntry(item.idx, "reel_name", v)} />
        )}
        {item.isCurrent ? (
          <td style={{ color: "var(--text-dim)", fontStyle: "italic" }}>current</td>
        ) : (
          <EditableCell value={e.project_name} onChange={(v) => updateEntry(item.idx, "project_name", v)} />
        )}
        {item.isCurrent ? (
          <td>{e.version}</td>
        ) : (
          <EditableCell value={e.version || ""} onChange={(v) => updateEntry(item.idx, "version", v)} />
        )}
        <td style={{ fontWeight: 600 }}>{e.total_changes}</td>
        <td>{e.trims}</td>
        <td className="delta-pos">{e.shots_added || ""}</td>
        <td className="delta-neg">{e.shots_removed || ""}</td>
        <td>{e.shots_replaced || ""}</td>
        <td>{e.camera_swaps || ""}</td>
        <td>{e.edit_shifts || ""}</td>
        <td>{e.jump_cuts || ""}</td>
        <td className={e.net_delta_frames > 0 ? "delta-pos" : e.net_delta_frames < 0 ? "delta-neg" : "delta-zero"}
            style={{ fontFamily: "var(--font-mono)" }}>
          {e.net_delta_tc}
        </td>
      </tr>
    );
  };

  return (
    <div className="analytics-panel">
      <div className="analytics-tabs">
        <button className={`tab ${activeTab === "All" ? "active" : ""}`} onClick={() => setActiveTab("All")}>All</button>
        {projectNames.map((name) => (
          <button key={name} className={`tab ${activeTab === name ? "active" : ""}`} onClick={() => setActiveTab(name)}>{name}</button>
        ))}
      </div>

      <table>
        <thead>
          <tr>
            <th style={{ width: 30 }}></th>
            <th>Reel</th>
            <th>Project</th>
            <th>Version</th>
            <th title="Total number of changes detected">Changes</th>
            <th title="Head and/or tail trims on existing clips">Trims</th>
            <th title="Brand new shots">Added</th>
            <th title="Shots completely cut">Removed</th>
            <th title="One shot swapped for another">Replaced</th>
            <th title="Same scene/take, different camera">Swaps</th>
            <th title="Edit point moved with no TRT change">Shifts</th>
            <th title="Material removed from middle of clip">Jumps</th>
            <th title="Net total runtime change">Net TRT</th>
          </tr>
        </thead>
        <tbody>
          {reelNamesSorted.map((reel) => {
            const items = grouped[reel];
            const latest = items[0];
            const isExp = expanded.has(reel);
            return (
              <React.Fragment key={reel}>
                {renderRow(latest, true, reel, items.length, false)}
                {isExp && items.slice(1).map((item) => renderRow(item, false, reel, items.length, true))}
              </React.Fragment>
            );
          })}
        </tbody>
        {reelNamesSorted.length > 1 && (
          <tfoot>
            <tr className="totals-row">
              <td></td>
              <td style={{ fontWeight: 600, color: "var(--accent)" }}>Total</td>
              <td></td><td></td>
              <td style={{ fontWeight: 600 }}>{totals.total_changes}</td>
              <td>{totals.trims}</td>
              <td className="delta-pos">{totals.shots_added || ""}</td>
              <td className="delta-neg">{totals.shots_removed || ""}</td>
              <td>{totals.shots_replaced || ""}</td>
              <td>{totals.camera_swaps || ""}</td>
              <td>{totals.edit_shifts || ""}</td>
              <td>{totals.jump_cuts || ""}</td>
              <td className={totals.net_delta_frames > 0 ? "delta-pos" : totals.net_delta_frames < 0 ? "delta-neg" : "delta-zero"}
                  style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                {framesToDeltaTc(totals.net_delta_frames)}
              </td>
            </tr>
          </tfoot>
        )}
      </table>

      {pendingDelete !== null && (
        <div className="modal-overlay" onClick={() => setPendingDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <p>Delete this analytics entry?</p>
            <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "8px 0" }}>
              {analytics[pendingDelete]?.reel_name} — {analytics[pendingDelete]?.project_name}
            </p>
            <div className="modal-buttons">
              <button onClick={() => setPendingDelete(null)}>Cancel</button>
              <button className="danger" onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {infoEntry && (
        <div className="modal-overlay" onClick={() => setInfoEntry(null)}>
          <div className="modal info-modal" onClick={(e) => e.stopPropagation()}>
            <div className="info-modal-header">
              <span>{infoEntry.reel_name}</span>
              <button className="toggle-btn" onClick={() => setInfoEntry(null)}>✕</button>
            </div>
            <table className="info-table">
              <tbody>
                <tr><td className="info-label">Project</td><td>{infoEntry.project_name || "—"}</td></tr>
                <tr><td className="info-label">Version</td><td>{infoEntry.version || "—"}</td></tr>
                <tr><td className="info-label">Date</td><td>{infoEntry.last_converted === "now" ? "Current session" : infoEntry.last_converted}</td></tr>
                <tr><td className="info-label">Before</td><td className="info-filepath">{infoEntry.before_file || "—"}</td></tr>
                <tr><td className="info-label">After</td><td className="info-filepath">{infoEntry.after_file || "—"}</td></tr>
                <tr><td className="info-label">Before clips</td><td>{infoEntry.before_clips}</td></tr>
                <tr><td className="info-label">After clips</td><td>{infoEntry.after_clips}</td></tr>
                <tr><td className="info-label">Net TRT</td>
                  <td className={infoEntry.net_delta_frames > 0 ? "delta-pos" : infoEntry.net_delta_frames < 0 ? "delta-neg" : ""}>{infoEntry.net_delta_tc}</td>
                </tr>
              </tbody>
            </table>
            <div className="info-breakdown">
              <span className="info-breakdown-title">Change Breakdown</span>
              <div className="info-breakdown-grid">
                <span>Trims</span><span>{infoEntry.trims}</span>
                <span>Added</span><span className="delta-pos">{infoEntry.shots_added}</span>
                <span>Removed</span><span className="delta-neg">{infoEntry.shots_removed}</span>
                <span>Replaced</span><span>{infoEntry.shots_replaced}</span>
                <span>Camera swaps</span><span>{infoEntry.camera_swaps}</span>
                <span>Edit shifts</span><span>{infoEntry.edit_shifts}</span>
                <span>Jump cuts</span><span>{infoEntry.jump_cuts}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- EditableCell ----

function EditableCell({
  value, onChange, className, style, mono,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  style?: React.CSSProperties;
  mono?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  if (!editing) {
    return (
      <td className={className} style={{ ...style, cursor: "text" }}
          onDoubleClick={() => { setDraft(value); setEditing(true); }}>
        {value}
      </td>
    );
  }

  return (
    <td className={className} style={style}>
      <input
        ref={inputRef}
        className="inline-edit"
        style={mono ? { fontFamily: "var(--font-mono)" } : undefined}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { onChange(draft); setEditing(false); }
          if (e.key === "Escape") { setEditing(false); }
        }}
        onBlur={() => { onChange(draft); setEditing(false); }}
      />
    </td>
  );
}

// ---- Main App ----

function App() {
  const [beforeFile, setBeforeFile] = useState<File | null>(null);
  const [afterFile, setAfterFile] = useState<File | null>(null);
  const [beforeName, setBeforeName] = useState(() => localStorage.getItem("clt_beforeName") || "");
  const [afterName, setAfterName] = useState(() => localStorage.getItem("clt_afterName") || "");
  const [projectName, setProjectName] = useState(() => localStorage.getItem("clt_projectName") || "");
  const [versionDate, setVersionDate] = useState(() => localStorage.getItem("clt_versionDate") || "");
  const [reelName, setReelName] = useState(() => localStorage.getItem("clt_reelName") || "Reel 1");
  const [mode, setMode] = useState(() => localStorage.getItem("clt_mode") || "both");

  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [editedRows, setEditedRows] = useState<Map<number, Partial<CsvRow>>>(new Map());
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [copied, setCopied] = useState(false);

  const [showAnalytics, setShowAnalytics] = useState(false);
  const [analytics, setAnalytics] = useState<ReelStats[]>([]);

  // Persist settings
  useEffect(() => { localStorage.setItem("clt_beforeName", beforeName); }, [beforeName]);
  useEffect(() => { localStorage.setItem("clt_afterName", afterName); }, [afterName]);
  useEffect(() => { localStorage.setItem("clt_projectName", projectName); }, [projectName]);
  useEffect(() => { localStorage.setItem("clt_versionDate", versionDate); }, [versionDate]);
  useEffect(() => { localStorage.setItem("clt_reelName", reelName); }, [reelName]);
  useEffect(() => { localStorage.setItem("clt_mode", mode); }, [mode]);

  // Restore analytics from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem("clt_analytics");
      if (saved) setAnalytics(JSON.parse(saved));
    } catch {}
  }, []);

  const detectReel = (name: string) => {
    const match = name.match(/[Rr](?:eel\s*)?(\d)/i);
    if (match) setReelName(`Reel ${match[1]}`);
  };

  const pickBefore = async () => {
    const file = await openFileDialog(".xml");
    if (file) {
      setBeforeFile(file);
      setBeforeName(file.name);
      detectReel(file.name);
    }
  };

  const pickAfter = async () => {
    const file = await openFileDialog(".xml");
    if (file) {
      setAfterFile(file);
      setAfterName(file.name);
      detectReel(file.name);
    }
  };

  const getEffectiveRow = (row: CsvRow): CsvRow => {
    const edits = editedRows.get(row.row_id);
    return edits ? { ...row, ...edits } : row;
  };

  const getVisibleRows = (): CsvRow[] => {
    if (!result) return [];
    return result.rows.filter((r) => !deletedIds.has(r.row_id)).map(getEffectiveRow);
  };

  const updateRowField = (rowId: number, field: keyof CsvRow, value: string) => {
    setEditedRows((prev) => {
      const next = new Map(prev);
      next.set(rowId, { ...(next.get(rowId) ?? {}), [field]: value });
      return next;
    });
  };

  const deleteRow = (rowId: number) => {
    setDeletedIds((prev) => { const next = new Set(prev); next.add(rowId); return next; });
  };

  const buildCsvContent = (): string => {
    const visibleRows = getVisibleRows();
    return exportCsvFiltered({
      rows: visibleRows,
      configJson: JSON.stringify({
        project_name: projectName || "Change List",
        version_date: versionDate || "",
        reel_name: reelName || "Reel 1",
        mode: mode === "individual" ? "Individual" : mode === "grouped" ? "Grouped" : "Both",
      }),
    });
  };

  const analyze = async () => {
    if (!beforeFile || !afterFile) return;
    setLoading(true);
    setStatus("Analyzing...");
    setError("");
    setEditedRows(new Map());
    setDeletedIds(new Set());

    try {
      const [beforeContent, afterContent] = await Promise.all([
        readFileText(beforeFile),
        readFileText(afterFile),
      ]);

      const res = analyzeXmls({ beforeContent, afterContent, project_name: projectName, version_date: versionDate, reel_name: reelName, mode });
      setResult(res);
      setStatus("");

      // Save to analytics
      const entry: ReelStats = {
        reel_name: reelName || "Reel 1",
        project_name: projectName || "",
        version: versionDate || "",
        last_converted: new Date().toISOString().slice(0, 10),
        before_file: beforeFile.name,
        after_file: afterFile.name,
        before_clips: res.before_clip_count,
        after_clips: res.after_clip_count,
        total_changes: res.total_changes,
        trims: res.stats.trims,
        shots_added: res.stats.shots_added,
        shots_removed: res.stats.shots_removed,
        shots_replaced: res.stats.shots_replaced,
        camera_swaps: res.stats.camera_swaps,
        edit_shifts: res.stats.edit_shifts,
        jump_cuts: res.stats.jump_cuts,
        net_delta_frames: res.net_trt_frames,
        net_delta_tc: res.net_trt_tc,
      };
      setAnalytics((prev) => {
        const updated = [...prev, entry];
        try { localStorage.setItem("clt_analytics", JSON.stringify(updated)); } catch {}
        return updated;
      });
    } catch (e: any) {
      setError(String(e));
      setStatus("");
    } finally {
      setLoading(false);
    }
  };

  const saveCsv = () => {
    if (!result) return;
    try {
      const csvContent = buildCsvContent();
      const filename = `${projectName || "change_list"}_${versionDate || "export"}.csv`;
      downloadFile(csvContent, filename);
    } catch (e: any) {
      setError(String(e));
    }
  };

  const copyCsvToClipboard = async () => {
    if (!result) return;
    try {
      const csvContent = buildCsvContent();
      const tsv = csvToTsv(csvContent);
      await navigator.clipboard.writeText(tsv);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e: any) {
      setError(String(e));
    }
  };

  const importMarkerXml = async () => {
    const file = await openFileDialog(".xml");
    if (!file) return;

    setLoading(true);
    setError("");
    try {
      const xmlContent = await readFileText(file);
      const res = convertMarkersToResult({ xmlContent, project_name: projectName, version_date: versionDate, reel_name: reelName });
      setResult(res);
      setEditedRows(new Map());
      setDeletedIds(new Set());
    } catch (e: any) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const deltaClass = (delta: string) => {
    if (delta.startsWith("+")) return "delta-pos";
    if (delta.startsWith("-")) return "delta-neg";
    return "delta-zero";
  };

  const confClass = (label: string) => label.toLowerCase();
  const visibleRows = getVisibleRows();

  return (
    <div className="app">
      <div className="header">
        <h1>CHANGE LIST TOOL</h1>
        {result && !showAnalytics && (
          <span className="stats">
            {result.before_clip_count > 0 && <>{result.before_clip_count} clips → {result.after_clip_count} clips | </>}
            {result.total_changes} changes detected
            {result.net_trt_tc && (
              <> | Net TRT: <span className={result.net_trt_frames > 0 ? "delta-pos" : result.net_trt_frames < 0 ? "delta-neg" : ""}>{result.net_trt_tc}</span></>
            )}
          </span>
        )}
        <button
          style={{ marginLeft: "auto" }}
          onClick={() => {
            if (!result) return;
            setShowAnalytics(!showAnalytics);
          }}
          disabled={!result}
        >
          {showAnalytics ? "Back" : "Analytics"}
        </button>
      </div>

      <div className="controls">
        <div className="file-input">
          <label>Before</label>
          <button onClick={pickBefore}>
            {beforeName || "Select XML..."}
          </button>
        </div>
        <div className="file-input">
          <label>After</label>
          <button onClick={pickAfter}>
            {afterName || "Select XML..."}
          </button>
        </div>

        <div className="separator" />

        <div className="select-wrapper" title="Individual: one row per change. Grouped: changes at the same timecode merged. Both: individual rows with re-edit annotations.">
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="individual">Individual</option>
            <option value="grouped">Grouped</option>
            <option value="both">Both</option>
          </select>
        </div>

        <button className="primary" onClick={analyze} disabled={!beforeFile || !afterFile || loading}>
          {loading ? (status || "Analyzing...") : "Analyze"}
        </button>

        {result && (
          <>
            <div className="separator" />
            <button onClick={saveCsv}>Export CSV</button>
            <button onClick={copyCsvToClipboard} title="Copy as tab-separated values for Google Sheets">
              {copied ? "Copied!" : "Copy TSV"}
            </button>
          </>
        )}

        <div className="separator" />
        <button onClick={importMarkerXml} disabled={loading} title="Import a Premiere-exported XML with markers and convert to CSV">
          Import Markers
        </button>
      </div>

      {/* Config row */}
      <div className="controls config-row">
        <input
          placeholder="Project Name"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
        />
        <input
          placeholder="Version Date (e.g. 260318)"
          value={versionDate}
          onChange={(e) => setVersionDate(e.target.value)}
        />
        <select value={reelName} onChange={(e) => setReelName(e.target.value)}>
          {[1,2,3,4,5,6,7].map(n => (
            <option key={n} value={`Reel ${n}`}>Reel {n}</option>
          ))}
        </select>
      </div>

      {error && (
        <div style={{ padding: "8px 24px", background: "rgba(248, 113, 113, 0.1)", color: "var(--low)", fontSize: 12 }}>
          {error}
        </div>
      )}

      {deletedIds.size > 0 && (
        <div className="undo-bar">
          <span>{deletedIds.size} row{deletedIds.size > 1 ? "s" : ""} deleted</span>
          <button onClick={() => setDeletedIds(new Set())}>Undo All</button>
        </div>
      )}

      <div className="results">
        {showAnalytics && result ? (
          <AnalyticsPanel
            result={result}
            analytics={analytics}
            onUpdate={setAnalytics}
            reelName={reelName}
            projectName={projectName}
            versionDate={versionDate}
            beforeName={beforeName}
            afterName={afterName}
          />
        ) : !result ? (
          <div className="empty-state">
            <div className="icon">&#x238C;</div>
            <p>Select Before and After XML files, then click Analyze</p>
            <p style={{ fontSize: 12, color: "var(--text-dim)" }}>Or use Import Markers to convert a Premiere marker XML to CSV</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 30 }}></th>
                <th style={{ width: 80 }}>Scene</th>
                <th style={{ width: 120 }}>Timecode</th>
                <th>Description</th>
                <th style={{ width: 120 }}>+/- Frames</th>
                <th style={{ width: 90 }}>Confidence</th>
                <th style={{ width: 120 }}>Clip</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((rawRow) => {
                if (deletedIds.has(rawRow.row_id)) return null;
                const row = getEffectiveRow(rawRow);
                return (
                  <tr key={row.row_id} className={row.is_summary ? "summary" : ""}>
                    <td>
                      <button className="toggle-btn delete-btn" onClick={() => deleteRow(row.row_id)} title="Remove row">✕</button>
                    </td>
                    <EditableCell value={row.scene} className="scene" onChange={(v) => updateRowField(row.row_id, "scene", v)} />
                    <EditableCell value={row.timecode} className="tc" mono onChange={(v) => updateRowField(row.row_id, "timecode", v)} />
                    <EditableCell value={row.description} onChange={(v) => updateRowField(row.row_id, "description", v)} />
                    <EditableCell value={row.delta} className={deltaClass(row.delta)} mono onChange={(v) => updateRowField(row.row_id, "delta", v)} />
                    <td>
                      {row.confidence > 0 && (
                        <span className={`confidence ${confClass(row.confidence_label)}`}>{row.confidence}%</span>
                      )}
                    </td>
                    <EditableCell value={row.clip_name} style={{ color: "var(--text-dim)", fontSize: 11 }} onChange={(v) => updateRowField(row.row_id, "clip_name", v)} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="status-bar">
        <span>{visibleRows.length > 0 ? `${visibleRows.length} rows` : ""}</span>
        <span style={{ color: "var(--text-dim)" }}>change-list-web · {loading ? status || "processing…" : "ready"}</span>
      </div>
    </div>
  );
}

export default App;
