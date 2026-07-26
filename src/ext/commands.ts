/**
 * /run, /scripts, /help commands and the Telegram bot command menu.
 *
 * buildCommandMenu() is the single source of truth for both /help's text and
 * bot.api.setMyCommands(), so the two can never drift apart.
 */

import type { Bot, Context } from "grammy";
import { ALLOWED_USERS } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { escapeHtml } from "../formatting";
import { SCRIPTS, findScript, tokenizeArgs, runScript, type ScriptDef } from "./scripts";

export interface MenuEntry {
  command: string;
  description: string;
}

const NATIVE_COMMANDS: MenuEntry[] = [
  { command: "new", description: "Start a fresh Claude session" },
  { command: "stop", description: "Stop the current query" },
  { command: "status", description: "Show detailed status" },
  { command: "resume", description: "Resume a previous session" },
  { command: "retry", description: "Retry the last message" },
  { command: "restart", description: "Restart the bot" },
];

/**
 * Pure function: native commands + run/scripts/help, in one place so
 * /help and the Telegram "/" menu can't drift out of sync.
 */
export function buildCommandMenu(): MenuEntry[] {
  return [
    ...NATIVE_COMMANDS,
    { command: "run", description: "Run a whitelisted ~/.bin script" },
    { command: "scripts", description: "List runnable scripts" },
    { command: "help", description: "Show this help" },
  ];
}

export async function registerBotMenu(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(buildCommandMenu());
}

function formatScriptEntry(def: (typeof SCRIPTS)[number]): string {
  const argsHint = def.args?.length ? ` ${def.args.map((a) => `<${a}>`).join(" ")}` : "";
  const fileHint = def.acceptsFile ? " 📎" : "";
  return `<code>/run ${escapeHtml(def.name)}${escapeHtml(argsHint)}</code>${fileHint}\n   ${escapeHtml(def.description)}`;
}

export async function handleScripts(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (SCRIPTS.length === 0) {
    await ctx.reply(
      "No scripts configured. Add some to src/ext/scripts.config.ts (see scripts.config.example.ts)."
    );
    return;
  }

  const lines = ["📜 <b>Runnable scripts</b>\n", ...SCRIPTS.map(formatScriptEntry)];
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

export async function handleHelp(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const menu = buildCommandMenu();
  const lines = [
    "🤖 <b>Commands</b>\n",
    ...menu.map((e) => `/${e.command} - ${escapeHtml(e.description)}`),
  ];

  if (SCRIPTS.length > 0) {
    lines.push("", "📜 <b>Scripts</b> (attach a file with 📎 ones to pass it as an argument)\n");
    lines.push(...SCRIPTS.map(formatScriptEntry));
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * Runs a script and replies with its result. Shared by handleRun (typed
 * /run, no attachment) and file-run-intercept.ts (caption + attachment).
 */
export async function replyWithScriptResult(
  ctx: Context,
  scriptName: string,
  args: string[],
  list: ScriptDef[] = SCRIPTS
): Promise<void> {
  const def = findScript(list, scriptName);
  if (!def) {
    const known = list.map((s) => s.name).join(", ") || "(none configured)";
    await ctx.reply(`❌ Unknown script "${escapeHtml(scriptName)}". Known: ${escapeHtml(known)}`, {
      parse_mode: "HTML",
    });
    return;
  }

  const statusMsg = await ctx.reply(`▶️ Running <code>${escapeHtml(def.name)}</code>...`, {
    parse_mode: "HTML",
  });

  const result = await runScript(def, args);

  const parts = [`✅ <code>${escapeHtml(def.name)}</code> finished`];
  if (result.timedOut) {
    parts[0] = `⏱️ <code>${escapeHtml(def.name)}</code> timed out`;
  } else if (result.exitCode !== 0) {
    parts[0] = `⚠️ <code>${escapeHtml(def.name)}</code> exited with code ${result.exitCode}`;
  }
  if (result.stdout.trim()) {
    parts.push(`<b>stdout:</b>\n<pre>${escapeHtml(result.stdout.trim())}</pre>`);
  }
  if (result.stderr.trim()) {
    parts.push(`<b>stderr:</b>\n<pre>${escapeHtml(result.stderr.trim())}</pre>`);
  }

  try {
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, parts.join("\n\n"), {
      parse_mode: "HTML",
    });
  } catch {
    await ctx.reply(parts.join("\n\n"), { parse_mode: "HTML" });
  }
}

export async function handleRun(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const [allowed, retryAfter] = rateLimiter.check(userId!);
  if (!allowed) {
    await ctx.reply(`⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
    return;
  }

  const raw = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (!raw) {
    await ctx.reply("Usage: /run &lt;script&gt; [args...]. See /scripts for the list.", {
      parse_mode: "HTML",
    });
    return;
  }

  const [scriptName, ...args] = tokenizeArgs(raw);
  if (!scriptName) {
    await ctx.reply("Usage: /run &lt;script&gt; [args...]. See /scripts for the list.", {
      parse_mode: "HTML",
    });
    return;
  }

  console.log(`/run ${scriptName} (${args.length} args) from @${username}`);
  await replyWithScriptResult(ctx, scriptName, args);
}
