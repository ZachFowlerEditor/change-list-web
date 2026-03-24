import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = url && key ? createClient(url, key) : null;

// Sign in anonymously on load so RLS policies can identify the user
if (supabase) {
  supabase.auth.getSession().then(({ data: { session } }) => {
    if (!session) {
      supabase.auth.signInAnonymously();
    }
  });
}

async function getCurrentUserId(): Promise<string | undefined> {
  if (!supabase) return undefined;
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id;
}

export interface ReelStatsRow {
  id?: string;
  created_at?: string;
  updated_at?: string;
  user_id?: string;
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

const TABLE = "clt_reel_stats";
const LS_KEY = "clt_analytics";
const LS_PENDING_KEY = "clt_analytics_pending";

/** Load all rows from Supabase, sorted by created_at asc. Falls back to localStorage. */
export async function loadAnalytics(): Promise<ReelStatsRow[]> {
  if (!supabase) return loadFromLocalStorage();

  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: true });

  if (error || !data) {
    console.warn("Supabase load failed, using localStorage:", error?.message);
    return loadFromLocalStorage();
  }

  // Sync any pending local-only entries
  await syncPendingToSupabase();

  return data as ReelStatsRow[];
}

/** Save a new run. Deduplication: same reel_name + before_file + after_file → UPDATE, else INSERT. */
export async function saveAnalyticsEntry(entry: ReelStatsRow): Promise<ReelStatsRow> {
  if (!supabase) {
    saveToLocalStorage(entry);
    addToPending(entry);
    return entry;
  }

  try {
    const userId = await getCurrentUserId();

    // Check for existing row with same dedup key (scoped to current user)
    const { data: existing } = await supabase
      .from(TABLE)
      .select("id")
      .eq("reel_name", entry.reel_name)
      .eq("before_file", entry.before_file)
      .eq("after_file", entry.after_file)
      .maybeSingle();

    if (existing?.id) {
      const { data, error } = await supabase
        .from(TABLE)
        .update({ ...entry, user_id: userId, updated_at: new Date().toISOString() })
        .eq("id", existing.id)
        .select()
        .single();
      if (error) throw error;
      return data as ReelStatsRow;
    } else {
      const { data, error } = await supabase
        .from(TABLE)
        .insert({ ...entry, user_id: userId })
        .select()
        .single();
      if (error) throw error;
      return data as ReelStatsRow;
    }
  } catch (err) {
    console.warn("Supabase save failed, saving to localStorage:", err);
    saveToLocalStorage(entry);
    addToPending(entry);
    return entry;
  }
}

/** Update a specific field on a row by id. */
export async function updateAnalyticsField(id: string, field: string, value: string): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from(TABLE)
      .update({ [field]: value, updated_at: new Date().toISOString() })
      .eq("id", id);
  } catch (err) {
    console.warn("Supabase update failed:", err);
  }
}

/** Delete a row by id. */
export async function deleteAnalyticsEntry(id: string): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from(TABLE).delete().eq("id", id);
  } catch (err) {
    console.warn("Supabase delete failed:", err);
  }
}

// ---- localStorage helpers ----

function loadFromLocalStorage(): ReelStatsRow[] {
  try {
    const saved = localStorage.getItem(LS_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

function saveToLocalStorage(entry: ReelStatsRow) {
  try {
    const existing = loadFromLocalStorage();
    const idx = existing.findIndex(
      (e) => e.reel_name === entry.reel_name && e.before_file === entry.before_file && e.after_file === entry.after_file
    );
    if (idx >= 0) existing[idx] = entry;
    else existing.push(entry);
    localStorage.setItem(LS_KEY, JSON.stringify(existing));
  } catch {}
}

function addToPending(entry: ReelStatsRow) {
  try {
    const pending: ReelStatsRow[] = JSON.parse(localStorage.getItem(LS_PENDING_KEY) || "[]");
    pending.push(entry);
    localStorage.setItem(LS_PENDING_KEY, JSON.stringify(pending));
  } catch {}
}

async function syncPendingToSupabase() {
  if (!supabase) return;
  try {
    const raw = localStorage.getItem(LS_PENDING_KEY);
    if (!raw) return;
    const pending: ReelStatsRow[] = JSON.parse(raw);
    if (!pending.length) return;

    for (const entry of pending) {
      await saveAnalyticsEntry(entry);
    }
    localStorage.removeItem(LS_PENDING_KEY);
  } catch {}
}
