/**
 * Whitelisted script runner for the `,`-prefixed automation scripts in ~/.bin/.
 *
 * The allowlist is explicit and opt-in (src/ext/scripts.config.ts, gitignored,
 * see scripts.config.example.ts) — nothing is runnable unless a script is
 * deliberately added there. Several ~/.bin scripts embed live credentials or
 * print secrets to stdout; excluding those from the allowlist is the actual
 * safety control here, not output filtering (which can't be made reliable).
 *
 * Execution always uses an argv array (Bun.spawn), never a shell string, so
 * arguments can never be shell-interpreted regardless of their content.
 */

import { resolve } from "path";

export interface ScriptDef {
  /** Short identifier users type after /run, e.g. "transcribe" (not the raw ,file.sh name). */
  name: string;
  /** Absolute path to the script on disk. */
  path: string;
  description: string;
  /** Human-readable arg names shown in /help and /scripts, e.g. ["file", "outputDir"]. */
  args?: string[];
  /** Whether a Telegram-attached file may be substituted in as an argument. */
  acceptsFile?: boolean;
  timeoutMs?: number;
}

export interface ScriptResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.SCRIPT_TIMEOUT_MS) || 30_000;
const OUTPUT_MAX_CHARS = Number(process.env.SCRIPT_OUTPUT_MAX_CHARS) || 3500;

function truncate(text: string): string {
  if (text.length <= OUTPUT_MAX_CHARS) return text;
  return text.slice(0, OUTPUT_MAX_CHARS) + "\n… [truncated]";
}

/**
 * Load the user-maintained allowlist from scripts.config.ts, mirroring how
 * config.ts loads the gitignored mcp-config.ts. Absent file -> empty allowlist,
 * not an error.
 */
async function loadScripts(): Promise<ScriptDef[]> {
  try {
    const configPath = resolve(import.meta.dir, "scripts.config.ts");
    const mod = await import(configPath).catch(() => null);
    if (Array.isArray(mod?.SCRIPTS)) {
      return mod.SCRIPTS as ScriptDef[];
    }
  } catch {
    // no scripts.config.ts found - allowlist stays empty
  }
  return [];
}

export const SCRIPTS: ScriptDef[] = await loadScripts();

export function findScript(list: ScriptDef[], name: string): ScriptDef | undefined {
  return list.find((s) => s.name === name);
}

/**
 * Small shell-like tokenizer supporting single/double-quoted args with spaces.
 * This only splits text into argv entries - it never invokes a shell, so
 * shell metacharacters inside an argument (";", "|", "$(...)", etc.) are
 * preserved literally and passed through as-is to the target script.
 */
export function tokenizeArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    if (quote) {
      if (ch === "\\" && input[i + 1] === quote) {
        current += quote;
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
        i++;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current) args.push(current);
  return args;
}

export async function runScript(
  def: ScriptDef,
  args: string[]
): Promise<ScriptResult> {
  const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // detached: true puts the child in its own process group so a timeout can
  // kill the whole tree (e.g. a bash script's `sleep`/subprocess children),
  // not just the immediate child - otherwise an orphaned grandchild can keep
  // holding the stdout pipe open and hang the read indefinitely.
  const proc = Bun.spawn([def.path, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return {
      exitCode: timedOut ? null : exitCode,
      stdout: truncate(stdout),
      stderr: truncate(stderr),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}
