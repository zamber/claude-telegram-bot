/**
 * Bonus feature: attach a file to a message with a caption like
 * "/run transcribe {file}" and have it passed to the script as an argument.
 *
 * grammY's bot.command() only matches message.text, never captions (by
 * design - see grammy's composer.d.ts), so this is implemented as its own
 * middleware rather than through bot.command(). It must be registered
 * *before* the existing document/photo/audio/video handlers in index.ts: on
 * a match it downloads the file, runs the script, and does not call next(),
 * short-circuiting the update. On a non-match it calls next() immediately,
 * so normal attachment uploads are completely unaffected - document.ts,
 * photo.ts, audio.ts and video.ts are never touched by this feature.
 */

import type { Context, NextFunction } from "grammy";
import { ALLOWED_USERS } from "../config";
import { isAuthorized } from "../security";
import { isPathAllowed } from "../security";
import { SCRIPTS, findScript, tokenizeArgs, type ScriptDef } from "./scripts";
import { replyWithScriptResult } from "./commands";
import { downloadAttachment, type DownloadedFile } from "./download";

const RUN_CAPTION_RE = /^\/run(?:@\w+)?\s+(.+)$/s;

export function parseRunCaption(caption: string | undefined): string[] | null {
  if (!caption) return null;
  const match = RUN_CAPTION_RE.exec(caption.trim());
  if (!match) return null;
  return tokenizeArgs(match[1]!);
}

export function hasAttachment(ctx: Context): boolean {
  const msg = ctx.message;
  return !!(msg?.document || msg?.photo?.length || msg?.audio || msg?.video);
}

/** Substitutes {file} if present, otherwise appends the path as the last arg. */
export function substituteFileArg(args: string[], filePath: string): string[] {
  if (args.includes("{file}")) {
    return args.map((a) => (a === "{file}" ? filePath : a));
  }
  return [...args, filePath];
}

export interface FileRunDeps {
  list?: ScriptDef[];
  download?: (ctx: Context) => Promise<DownloadedFile | null>;
}

export function createFileRunMiddleware(deps: FileRunDeps = {}) {
  const list = deps.list ?? SCRIPTS;
  const download = deps.download ?? downloadAttachment;

  return async (ctx: Context, next: NextFunction): Promise<void> => {
    if (!hasAttachment(ctx)) {
      return next();
    }

    const args = parseRunCaption(ctx.message?.caption);
    if (!args) {
      return next();
    }

    const userId = ctx.from?.id;
    if (!isAuthorized(userId, ALLOWED_USERS)) {
      await ctx.reply("Unauthorized. Contact the bot owner for access.");
      return;
    }

    const [scriptName, ...restArgs] = args;
    if (!scriptName) {
      await ctx.reply("Usage: caption \"/run &lt;script&gt; [args...]\"", {
        parse_mode: "HTML",
      });
      return;
    }

    const def = findScript(list, scriptName);
    if (!def) {
      await ctx.reply(`❌ Unknown script "${scriptName}".`);
      return;
    }
    if (!def.acceptsFile) {
      await ctx.reply(`❌ Script "${scriptName}" does not accept a file attachment.`);
      return;
    }

    const downloaded = await download(ctx);
    if (!downloaded || !isPathAllowed(downloaded.path)) {
      await ctx.reply("❌ Failed to download the attached file.");
      return;
    }

    const finalArgs = substituteFileArg(restArgs, downloaded.path);
    await replyWithScriptResult(ctx, scriptName, finalArgs, list);
  };
}

export const fileRunMiddleware = createFileRunMiddleware();
