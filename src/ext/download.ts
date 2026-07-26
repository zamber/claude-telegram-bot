/**
 * Standalone Telegram attachment download helper for the /run file-argument
 * feature. Deliberately not shared with the existing per-type handlers
 * (photo.ts/document.ts/audio.ts/video.ts) even though the download pattern
 * is the same (ctx.getFile() + a direct fetch against the Bot API file
 * endpoint) - keeping this self-contained means those files never need to
 * change for this feature to exist.
 */

import type { Context } from "grammy";
import { TEMP_DIR } from "../config";

export interface DownloadedFile {
  path: string;
  fileName: string;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Downloads whatever attachment (document/photo/audio/video) is on the
 * message into a scoped path under TEMP_DIR. Returns null if the message
 * has no supported attachment.
 */
export async function downloadAttachment(
  ctx: Context,
  fetchImpl: typeof fetch = fetch
): Promise<DownloadedFile | null> {
  const msg = ctx.message;
  const photo = msg?.photo?.[msg.photo.length - 1];
  const attachment = msg?.document ?? photo ?? msg?.audio ?? msg?.video;

  if (!attachment) return null;

  const file = await ctx.getFile();
  if (!file.file_path) return null;

  const rawName =
    ("file_name" in attachment && attachment.file_name) ||
    file.file_path.split("/").pop() ||
    `file_${Date.now()}`;
  const fileName = sanitizeFileName(rawName);

  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const path = `${TEMP_DIR}/run_${timestamp}_${random}_${fileName}`;

  const response = await fetchImpl(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(path, buffer);

  return { path, fileName };
}
