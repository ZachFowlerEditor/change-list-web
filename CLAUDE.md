# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Dev server:** `npm run dev` (Vite)
- **Build:** `npm run build` (runs `tsc && vite build`)
- **Preview production build:** `npm run preview`

No test framework is configured. No linter is configured.

## Architecture

Web port of a Rust/Tauri desktop app ("Change List Tool") for comparing two FCP XML timeline exports and generating a change list. React 18 + TypeScript + Vite, no routing or state management library.

### Core pipeline (`src/lib/`)

All processing is pure TypeScript ported from Rust, running entirely in the browser:

1. **xmlParser.ts** — Parses FCP XML (Final Cut Pro 7 interchange format) via browser `DOMParser`. Extracts `Timeline` and `Clip` structs. Handles through-edit merging and transition adjustments.
2. **changeDetector.ts** — Diffs two `Timeline`s: matches clips by name/source file/source overlap, then detects trims, shot adds/removes/replacements, camera swaps, edit point shifts, and jump cuts. Contains multiple post-processing passes (dedup, merge consecutive, detect replacements/shifts).
3. **csvGenerator.ts** — Converts `Change[]` and `ChangeGroup[]` into `CsvRow[]` for display. Three output modes: `individual`, `grouped`, `both`. Also handles CSV export and CSV-to-TSV conversion.
4. **timeline.ts** — Core types (`Timeline`, `Clip`) and frame/timecode utilities. All timecodes are frame-based at 24fps default.
5. **markerConverter.ts** — Alternate import path: parses Premiere marker XML into CsvRows (pipe-delimited comment format).
6. **analyze.ts** — Orchestration layer that wires parser → detector → CSV generator. Entry points: `analyzeXmls()`, `convertMarkersToResult()`, `exportCsvFiltered()`.
7. **supabase.ts** — Analytics persistence with Supabase (anonymous auth + RLS). Falls back to localStorage. Env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

### UI (`src/App.tsx`)

Single-file React app. Key concepts:
- Two-file comparison workflow (Before/After XML upload → Analyze)
- Inline-editable result table with row deletion/undo
- Analytics panel: historical run tracking grouped by reel name, with project tabs
- Settings persisted to localStorage (project name, version date, reel, mode)
- Dedup key for analytics: `reel_name + before_file + after_file`

### Domain terminology

- **Leader frames** (default 192 = 8 seconds at 24fps): head/tail slate/countdown clips filtered out before comparison
- **Through-edit**: Adjacent clips from same source merged into one logical clip
- **Re-edit**: Dense cluster of 3+ changes within 120-frame window, displayed as grouped summary
- **Scene normalization**: Strips V/VE/B prefixes and trailing camera letters from scene names
- **Camera swap**: Same scene/take but different camera angle (detected via clip name pattern `{scene}{camera}-{take}`)
