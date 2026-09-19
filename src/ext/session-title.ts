/**
 * Forum-topic auto-rename using Claude's auto-generated session name.
 *
 * The Agent SDK does not expose the auto-generated session title in its
 * message stream (verified against SDK 0.1.76 type definitions). However, the
 * Claude Code CLI subprocess writes a per-session `slug` (e.g.
 * "smooth-swinging-fountain") into the session transcript at
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. We read that slug and
 * use it to rename the Telegram forum topic so the phone UI reflects the name
 * Claude itself assigned to the session.
 *
 * The JSONL layout is an implementation detail of the CLI, so this is
 * best-effort: any failure falls back to the caller's fallback title.
 */

import { homedir } from "os";
import { readFileSync } from "fs";
import type { Context } from "grammy";
import { AUTO_RENAME_TOPICS, WORKING_DIR } from "../config";

/** Path to the session transcript file for a given Claude session id. */
export function sessionTranscriptPath(sessionId: string): string {
  const encodedCwd = WORKING_DIR.replace(/\//g, "-");
  return `${homedir()}/.claude/projects/${encodedCwd}/${sessionId}.jsonl`;
}

/**
 * Pure helper: scan transcript text (from the end) for the first complete
 * `"slug":"..."` field. Scanning backwards means a partially-written trailing
 * line (the CLI is streaming) can't hide an already-complete slug on an
 * earlier line.
 */
export function extractSlugFromTranscript(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/"slug":"([^"]+)"/);
    if (m) return m[1]!;
  }
  return null;
}

export function getSessionSlug(sessionId: string): string | null {
  try {
    return extractSlugFromTranscript(
      readFileSync(sessionTranscriptPath(sessionId), "utf-8")
    );
  } catch {
    // File missing or unreadable — caller falls back to its own title.
    return null;
  }
}

/** "smooth-swinging-fountain" -> "Smooth Swinging Fountain". */
export function titleFromSlug(slug: string): string {
  const words = slug
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 1 ? w[0]!.toUpperCase() + w.slice(1) : w.toUpperCase()));
  const title = words.join(" ");
  return title.slice(0, 128);
}

/**
 * Rename the current Telegram forum topic to the session's auto-name. No-ops
 * unless we are inside a forum topic and AUTO_RENAME_TOPICS is enabled.
 * Failures (e.g. missing can_manage_topics rights) are logged, never thrown.
 */
export async function renameTopicToSessionTitle(
  ctx: Context,
  sessionId: string,
  fallbackTitle: string | null
): Promise<void> {
  if (!AUTO_RENAME_TOPICS) return;

  const threadId = ctx.msg?.message_thread_id;
  const chatId = ctx.chat?.id;
  if (!threadId || !chatId) return; // not a forum topic

  const slug = getSessionSlug(sessionId);
  const title = (slug ? titleFromSlug(slug) : fallbackTitle ?? "").trim();
  if (!title) return;

  try {
    // grammY flattens the raw API's object payload: positional params first,
    // then a trailing options object for the remaining fields.
    await ctx.api.editForumTopic(chatId, threadId, {
      name: title.slice(0, 128),
    });
    console.log(
      `[SessionTitle] Renamed topic ${threadId} to "${title}"` +
        (slug ? ` (slug: ${slug})` : " (fallback)")
    );
  } catch (e) {
    console.warn(`[SessionTitle] Failed to rename topic: ${e}`);
  }
}
