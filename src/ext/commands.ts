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
import { getSession } from "./session-manager";
import { buildCommandMenu, getClaudeCommandNames } from "./claude-commands";
import { resolvePendingPlanExit } from "./permissions";

export type { MenuEntry } from "./claude-commands";

/**
 * Turn plan mode off for this session and, if the CLI is currently waiting on
 * an ExitPlanMode approval, settle that request as an approval too. Without
 * the second half the bot-side flag flips while the CLI session stays in plan
 * mode — the exact deadlock that made /build look broken.
 */
function exitPlanMode(ctx: Context): boolean {
  const session = getSession(ctx);
  session.setPlanMode(false);
  return resolvePendingPlanExit(session.sessionKey);
}

/**
 * The Telegram "/" menu = native bot commands + harvested Claude
 * slash-commands/skills (see src/ext/claude-commands.ts). Single source of
 * truth for both /help and setMyCommands so they can't drift apart.
 */
export function buildMenuEntries(): ReturnType<typeof buildCommandMenu> {
  return buildCommandMenu(getClaudeCommandNames());
}

export async function registerBotMenu(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(buildMenuEntries());
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

  const menu = buildMenuEntries();
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

/**
 * /plan - Toggle plan mode, or run a prompt in plan mode.
 *
 * With no arguments it toggles the session's plan-mode flag (matching the
 * interactive CLI's /plan). With a prompt, it turns plan mode on and sends the
 * prompt through the normal text pipeline, which then runs with
 * permissionMode: 'plan'.
 */
export async function handlePlan(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const session = getSession(ctx);
  const prompt = typeof ctx.match === "string" ? ctx.match.trim() : "";

  if (!prompt) {
    if (session.planMode) {
      const resolvedPending = exitPlanMode(ctx);
      await ctx.reply(
        resolvedPending
          ? "✅ <b>Plan mode OFF</b>\nClaude's plan was approved, so it can execute tools now."
          : "✅ <b>Plan mode OFF</b>\nClaude can execute tools again.",
        { parse_mode: "HTML" }
      );
      return;
    }

    session.setPlanMode(true);
    await ctx.reply(
      "🧭 <b>Plan mode ON</b>\nClaude will research and plan without editing files. Send /plan again or /build to exit.",
      { parse_mode: "HTML" }
    );
    return;
  }

  session.setPlanMode(true);
  await ctx.reply("🧭 <b>Plan mode ON</b> — planning now...", {
    parse_mode: "HTML",
  });

  // Reuse the text pipeline so streaming, rate limiting, audit logging, and
  // retry logic all apply unchanged. Same pattern as handleRetry.
  const { handleText } = await import("../handlers/text");
  const fakeCtx = {
    ...ctx,
    message: { ...ctx.message, text: prompt },
  } as Context;
  await handleText(fakeCtx);
}

/**
 * /build - Exit plan mode explicitly (Claude can execute tools again).
 */
export async function handleBuild(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const resolvedPending = exitPlanMode(ctx);
  await ctx.reply(
    resolvedPending
      ? "✅ <b>Plan mode OFF</b>\nClaude's plan was approved, so it can execute tools now."
      : "✅ <b>Plan mode OFF</b>\nClaude can execute tools again.",
    { parse_mode: "HTML" }
  );
}
