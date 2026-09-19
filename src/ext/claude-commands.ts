/**
 * Dynamic Claude command harvesting + Telegram bot menu.
 *
 * The Claude Agent SDK sends a `system` message with `subtype: "init"` at the
 * start of every query. It includes the Claude Code CLI's `slash_commands`
 * and `skills` arrays. This module harvests those into module state and merges
 * them into the Telegram "/" command menu (setMyCommands) alongside the bot's
 * own native commands, so the phone UI reflects what the underlying Claude
 * Code process can actually do.
 *
 * This is a self-contained `src/ext/` module: the only touches outside it are
 * the additive harvest call in session.ts and the command registration in
 * index.ts.
 */

/** A single entry in the Telegram command menu. */
export interface MenuEntry {
  command: string;
  description: string;
}

interface ClaudeCommandState {
  /** Claude Code CLI slash-commands (e.g. "/init", "/compact", "/plan"). */
  slashCommands: string[];
  /** Discovered skills (e.g. "caveman", "mattpocock-skills"). */
  skills: string[];
  /** Joined sorted signature used to detect real changes. */
  signature: string;
}

const EMPTY: ClaudeCommandState = {
  slashCommands: [],
  skills: [],
  signature: "",
};

let state: ClaudeCommandState = EMPTY;

/** Map from sanitized Telegram command name back to the real Claude name. */
const sanitizeMap = new Map<string, string>();

/**
 * Called when the harvested command set changes (i.e. when a different set is
 * seen than last time). index.ts registers a callback that re-runs
 * setMyCommands so the Telegram menu stays in sync without re-registering on
 * every single message.
 */
let onChange: (() => void) | null = null;

export function setOnClaudeCommandsChanged(cb: (() => void) | null): void {
  onChange = cb;
}

/**
 * Store a freshly harvested command set. Returns true if it differs from the
 * previous set (caller may then want to re-register the Telegram menu).
 */
export function updateClaudeCommands(
  slashCommands: string[],
  skills: string[]
): boolean {
  const signature = JSON.stringify(
    [...slashCommands].sort().concat([...skills].sort())
  );
  if (signature === state.signature) return false;

  state = { slashCommands, skills, signature };
  // Rebuild the sanitize map only when the set actually changes.
  sanitizeMap.clear();
  for (const name of [...slashCommands, ...skills]) {
    const sanitized = sanitizeCommandName(name);
    if (sanitized && !sanitizeMap.has(sanitized)) {
      sanitizeMap.set(sanitized, name);
    }
  }

  // Fire-and-forget: the callback is async (Telegram API call).
  if (onChange) {
    queueMicrotask(() => onChange?.());
  }
  return true;
}

/** Current harvested set (for tests and for menu building). */
export function getClaudeCommandNames(): {
  slashCommands: string[];
  skills: string[];
} {
  return { slashCommands: state.slashCommands, skills: state.skills };
}

/**
 * Telegram command names allow only lowercase a-z, digits and underscores,
 * 1-32 chars. Claude names may contain hyphens, uppercase, etc. Sanitize to a
 * valid Telegram name; return null when nothing usable remains.
 */
export function sanitizeCommandName(name: string): string | null {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s || s.length > 32 || !/^[a-z0-9_]+$/.test(s)) return null;
  return s;
}

/**
 * Reverse a sanitized menu command name to the real Claude command/skill name
 * (e.g. "mattpocock_skills" -> "mattpocock-skills"). Returns the input when
 * no mapping exists. Used by the text handler so unknown "/x" messages are
 * passed through to Claude under the name Claude actually understands.
 */
export function translateMenuCommand(name: string): string {
  return sanitizeMap.get(name) ?? name;
}

/** Bot commands that are handled natively — never shadowed by Claude's list. */
export const NATIVE_BOT_COMMANDS: MenuEntry[] = [
  { command: "start", description: "Show welcome message and status" },
  { command: "new", description: "Start a fresh Claude session" },
  { command: "stop", description: "Stop the current query" },
  { command: "status", description: "Show detailed status" },
  { command: "resume", description: "Resume a previous session" },
  { command: "retry", description: "Retry the last message" },
  { command: "restart", description: "Restart the bot" },
  { command: "run", description: "Run a whitelisted ~/.bin script" },
  { command: "scripts", description: "List runnable scripts" },
  { command: "plan", description: "Toggle plan mode (Claude plans, no edits)" },
  { command: "build", description: "Exit plan mode" },
  { command: "help", description: "Show this help" },
];

const NATIVE_NAMES = new Set(NATIVE_BOT_COMMANDS.map((e) => e.command));

/** Telegram's hard limit on the number of bot commands. */
export const MAX_MENU_COMMANDS = 100;

/**
 * Build the full Telegram command menu: native bot commands first, then
 * harvested Claude slash-commands/skills (sanitized, deduped, capped at
 * Telegram's 100-command limit). Pure given the harvested state, so it is easy
 * to test and is the single source of truth for both /help and setMyCommands.
 */
export function buildCommandMenu(
  claude: { slashCommands: string[]; skills: string[] } | null
): MenuEntry[] {
  const result = [...NATIVE_BOT_COMMANDS];
  if (!claude) return result;

  const used = new Set(result.map((e) => e.command));
  const seen = new Set<string>();

  for (const name of [...claude.slashCommands, ...claude.skills]) {
    const cmd = sanitizeCommandName(name);
    if (!cmd || NATIVE_NAMES.has(cmd) || used.has(cmd) || seen.has(cmd)) {
      continue;
    }
    seen.add(cmd);
    const isSkill = claude.skills.includes(name);
    result.push({
      command: cmd,
      description: isSkill ? `Skill: ${name}` : `Claude: ${name}`,
    });
    if (result.length >= MAX_MENU_COMMANDS) break;
  }
  return result;
}

/** Test-only: reset module state. */
export function _resetClaudeCommandsForTest(): void {
  state = EMPTY;
  sanitizeMap.clear();
}
