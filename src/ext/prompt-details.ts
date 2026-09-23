/**
 * What a permission gate shows about the request it is asking about.
 *
 * `formatToolStatus` is built for progress updates, not for a decision: it hides
 * a Bash command whenever the CLI also sent a `description`, and it reduces an
 * Edit to a filename. A user cannot approve a command they cannot see, so the
 * gate describes the request itself.
 *
 * Every value that reaches Telegram is escaped here, and every section has a
 * character budget, so a hostile argument cannot break the HTML or push the
 * message past the Telegram limit.
 */

import { escapeHtml } from "../formatting";
import { checkCommandSafety } from "../security";

export type GateContext = {
  /** The CLI's own explanation of why it asked. */
  decisionReason?: string;
  /** Set by the CLI when a path failed its permission check. */
  blockedPath?: string;
};

export type GateDetails = {
  /** Plain text, unescaped: why this request needs a human. */
  risk?: string;
  /** Ready-to-send HTML showing the tool's own input. */
  preview?: string;
};

/** Character budgets, measured after escaping. */
const PREVIEW_BUDGET = 700;
const PATH_BUDGET = 200;
const TEXT_BUDGET = 200;

/** Escape, then cut, so an HTML entity is never left half-written. */
export function escapeTruncate(text: string, maxLength: number): string {
  let out = "";
  for (const character of text) {
    const escaped = escapeHtml(character);
    if (out.length + escaped.length > maxLength) return `${out}…`;
    out += escaped;
  }
  return out;
}

function pre(text: string): string {
  return `<pre>${escapeTruncate(text, PREVIEW_BUDGET)}</pre>`;
}

function code(text: string, budget = TEXT_BUDGET): string {
  return `<code>${escapeTruncate(text, budget)}</code>`;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function lineCount(text: string): number {
  return text ? text.split("\n").length : 0;
}

/** The path a filesystem tool is acting on, if it has one. */
function pathOf(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "NotebookEdit") return asString(input.notebook_path);
  return asString(input.file_path);
}

/**
 * Why the gate exists, most concrete source first: a blocked path beats a Bash
 * safety verdict beats the CLI's generic wording.
 */
function resolveRisk(context: GateContext, specific?: string): string | undefined {
  if (context.blockedPath) {
    return `Path is outside the allowed directories: ${context.blockedPath}`;
  }
  return specific || context.decisionReason || undefined;
}

/**
 * Describe a gate request. Returns an empty object for a tool with nothing
 * useful to show, so the caller can fall back to the plain prompt.
 */
export function describeGate(
  toolName: string,
  input: Record<string, unknown>,
  context: GateContext = {}
): GateDetails {
  switch (toolName) {
    case "Bash": {
      // A Bash gate only exists for a command the bot's own allowlist did not
      // accept, so the safety verdict is normally the reason - but a safe
      // command can still fall through, hence the fallbacks.
      const command = asString(input.command);
      const [, safetyReason] = checkCommandSafety(command);
      return {
        preview: pre(command),
        risk: resolveRisk(context, safetyReason),
      };
    }

    case "Edit": {
      const oldLines = lineCount(asString(input.old_string));
      const newLines = lineCount(asString(input.new_string));
      const counts =
        oldLines || newLines ? ` <code>+${newLines} -${oldLines}</code>` : "";
      return {
        preview: `${code(pathOf(toolName, input), PATH_BUDGET)}${counts}`,
        risk: resolveRisk(context),
      };
    }

    case "Write": {
      const lines = lineCount(asString(input.content));
      return {
        preview: `${code(pathOf(toolName, input), PATH_BUDGET)} <code>${lines} lines</code>`,
        risk: resolveRisk(context),
      };
    }

    case "NotebookEdit": {
      return {
        preview: code(pathOf(toolName, input), PATH_BUDGET),
        risk: resolveRisk(context),
      };
    }

    case "Read": {
      const offset = asString(String(input.offset ?? ""));
      const limit = asString(String(input.limit ?? ""));
      const range =
        offset || limit ? ` <code>${offset || "0"}–${limit || "end"}</code>` : "";
      return {
        preview: `${code(pathOf(toolName, input), PATH_BUDGET)}${range}`,
        risk: resolveRisk(context),
      };
    }

    case "Glob":
    case "Grep": {
      const pattern = asString(input.pattern);
      const path = asString(input.path);
      return {
        preview: path ? `${code(pattern)} in ${code(path, PATH_BUDGET)}` : code(pattern),
        risk: resolveRisk(context),
      };
    }

    case "WebFetch": {
      return { preview: code(asString(input.url), PATH_BUDGET), risk: resolveRisk(context) };
    }

    case "WebSearch": {
      return { preview: code(asString(input.query)), risk: resolveRisk(context) };
    }

    default: {
      let json: string;
      try {
        json = JSON.stringify(input, null, 2) ?? "";
      } catch {
        json = "<unserializable input>";
      }
      return { preview: pre(json), risk: resolveRisk(context) };
    }
  }
}
