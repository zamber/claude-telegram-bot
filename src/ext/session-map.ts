/**
 * Persistent session-key → session_id map.
 *
 * The runtime Map in session-manager.ts is lost on service restart, which
 * meant every forum topic started a brand-new Claude session after a restart
 * even though the transcripts were still on disk. This module persists the
 * "current Claude session per thread key" binding so the first message after a
 * restart resumes where the conversation left off.
 *
 * File format (JSON object):
 *   { "<sessionKey>": "<sessionId>" | null }
 *
 *   - present with an id → resume that session
 *   - absent or null     → start fresh (this is what /new writes)
 *
 * The file lives next to the session history (SESSION_FILE) and is written
 * synchronously on every change, so it is never stale for more than one event
 * loop tick even if the process is killed.
 *
 * Upgrade path: the very first time the map file is missing, it is backfilled
 * from the existing session history (most recent session per key) so topics
 * that were already in use resume on the first restart after deploying this
 * fix, not only on later ones.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { SESSION_MAP_FILE, SESSION_FILE } from "../config";

/** In-memory copy of the persisted map. Single source of truth while running. */
const mapCache = new Map<string, string | null>();
let loaded = false;

/** Resolve the current file path, honoring a test override via env. */
function mapFilePath(): string {
  return process.env.SESSION_MAP_FILE || SESSION_MAP_FILE;
}

function historyFilePath(): string {
  return process.env.SESSION_FILE || SESSION_FILE;
}

/**
 * One-time upgrade: seed the map from the session history so threads that were
 * already active before this module existed resume on the first restart too.
 * The history array is ordered most-recent-first (saveSession unshifts), so
 * the first session seen for a key is the one to bind.
 */
function backfillFromHistory(): void {
  try {
    const parsed = JSON.parse(
      readFileSync(historyFilePath(), "utf-8")
    ) as { sessions?: Array<{ session_id?: string; session_key?: string }> };
    for (const entry of parsed.sessions ?? []) {
      const key = entry.session_key ?? "default";
      if (entry.session_id && !mapCache.has(key)) {
        mapCache.set(key, entry.session_id);
      }
    }
    if (mapCache.size) {
      console.log(
        `[SessionMap] Backfilled ${mapCache.size} thread binding(s) from session history`
      );
    }
  } catch {
    // No readable history yet — nothing to backfill.
  }
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const file = mapFilePath();
  let hadFile = true;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" || value === null) {
        mapCache.set(key, value);
      }
    }
  } catch {
    hadFile = false;
  }
  if (!hadFile) {
    backfillFromHistory();
    persist();
  }
}

function persist(): void {
  try {
    const file = mapFilePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(Object.fromEntries(mapCache), null, 2));
  } catch (error) {
    console.warn(`[SessionMap] Failed to persist session map: ${error}`);
  }
}

/** The Claude session id currently bound to a thread key, or null if fresh. */
export function getMappedSessionId(sessionKey: string): string | null {
  load();
  return mapCache.get(sessionKey) ?? null;
}

/** Bind a thread key to a session id. Passing null clears it (as /new does). */
export function setMappedSessionId(
  sessionKey: string,
  sessionId: string | null
): void {
  load();
  mapCache.set(sessionKey, sessionId);
  persist();
}

/** Test-only: drop the in-memory cache so the next call re-reads the file. */
export function _resetSessionMapForTest(): void {
  mapCache.clear();
  loaded = false;
}
