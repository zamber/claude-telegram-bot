/**
 * Narrow "always allow" rules for the ♾️ button on a permission gate.
 *
 * The button used to replay the CLI's own `suggestions` verbatim. Two things
 * were wrong with that:
 *
 *   1. The CLI only sends suggestions for some tools (WebFetch normally sends
 *      none at all), so the button was missing exactly when it would have been
 *      useful.
 *   2. A suggestion is not always safe or even effective to accept blindly. A
 *      rule with no `ruleContent` grants the WHOLE tool, and some tool/rule
 *      combinations are stored but never consulted - so the button looks dead.
 *
 * This module synthesises a narrow rule instead, and filters suggestions down to
 * the shapes that do something. A suggestion is held to the SAME rules as a
 * synthesised one: the CLI offers the first two words of a command as a prefix,
 * so a gate for `sudo rm /tmp/x` arrives with `sudo rm:*` - which is refused
 * here, not honoured.
 *
 * The shapes that are kept:
 *
 *   - Bash       -> `Bash(<firstWord>:*)`. The CLI treats this as a prefix, so
 *                  `ls:*` covers `ls` and `ls -la` but never `gitleaks`. A first
 *                  word that hides the real command (`sudo`, `sh`, `xargs`,
 *                  `python`, ...) is refused, `rm` is never remembered, and a
 *                  command containing shell syntax (`;`, `|`, `&&`, `>`, `$(`,
 *                  ...) is refused too - a prefix rule would cover the second
 *                  command as well as the first.
 *   - Read/Glob/Grep           -> `Read(//<dir>/**)`. Only `Read(...)` rules
 *                  scope those three tools; `Glob(...)`/`Grep(...)` rules with
 *                  content are stored but never consulted. Read names a file,
 *                  so the rule covers its directory; Glob and Grep name a
 *                  directory, so the rule covers that directory itself.
 *   - Write/Edit/NotebookEdit  -> `Edit(//<dir>/**)`. Only `Edit(...)` rules
 *                  scope those three tools.
 *   - WebFetch    -> `WebFetch(domain:<host>)`, matched as an exact hostname.
 *                  A URL here is rejected by the CLI ("must be in domain:hostname
 *                  format"), so this strips scheme, port and path.
 *
 * Two conventions in the rule syntax are load-bearing:
 *   - A rule path with ONE leading slash is relative to the project root. Two
 *     slashes mean "absolute", so an absolute directory must be written
 *     `//dir/**`.
 *   - A rule that ends in `/**` is treated as a directory containment rule.
 *
 * Every rule here uses `destination: "session"`: in-memory for the life of the
 * CLI process, never written to disk. A tap on a phone screen is not consent to
 * change the user's saved settings.
 */

import type { PermissionRuleValue, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { BUTTON_LABEL_MAX_LENGTH } from "../config";

/**
 * First words that do not describe what actually runs. Remembering `sudo:*`
 * would grant every command as root; remembering `python:*` would grant every
 * script. Each of these is one short token with an unbounded surface.
 */
const OPAQUE_COMMANDS = new Set([
  // privilege escalation
  "sudo",
  "doas",
  "su",
  // launchers and wrappers
  "env",
  "xargs",
  "eval",
  "exec",
  "nohup",
  "time",
  "watch",
  "parallel",
  "busybox",
  // shells and interpreters
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ash",
  "python",
  "python3",
  "perl",
  "ruby",
  "node",
  "bun",
  "deno",
  "awk",
  "gawk",
  "make",
  // package managers and build tools
  "npm",
  "pnpm",
  "yarn",
  "pip",
  "pip3",
  "cargo",
  "go",
  "apt",
  "apt-get",
  "dnf",
  "yum",
  "brew",
  // version control and remote/system control
  "git",
  "ssh",
  "scp",
  "rsync",
  "docker",
  "kubectl",
  "systemctl",
  "service",
  // deletion is never remembered
  "rm",
]);

/**
 * Tools whose whole-tool rule (no `ruleContent`) is too much to grant from one
 * tap. A bare MCP or Task rule is fine; a bare `Bash` rule is not.
 */
const WHOLE_TOOL_DANGER = new Set([
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
]);

/** A rule content of exactly this would grant the whole tool. */
const WILDCARD = "*";

/** Only the standard word characters a real executable name can contain. */
const EXECUTABLE = /^[A-Za-z0-9_][A-Za-z0-9_.+@-]*$/;

/** Longest executable name worth putting in a rule. */
const MAX_EXECUTABLE_LENGTH = 40;

/**
 * Shell syntax that chains a second command onto the first, redirects its
 * output, or expands to something else at run time. A `Bash(<word>:*)` rule
 * matches a command by prefix, so `Bash(ls:*)` would also cover
 * `ls; rm -rf /` and `ls > /etc/passwd`. A command that contains any of these
 * gets no rule, and the gate keeps asking - which is the point.
 */
const SHELL_SYNTAX = /[;&|<>`$(){}\\\n\r]/;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The absolute directory a path names, or null when it names nothing worth
 * remembering (empty, relative, or the filesystem root).
 */
function absoluteDirectory(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const trimmed = path.replace(/\/+$/, "");
  return trimmed && trimmed !== "/" ? trimmed : null;
}

/**
 * The absolute directory that CONTAINS a file path, or null when there is no
 * such directory worth remembering.
 */
function directoryOf(filePath: string): string | null {
  const file = absoluteDirectory(filePath);
  if (!file) return null;
  const cut = file.lastIndexOf("/");
  if (cut <= 0) return null;
  const dir = file.slice(0, cut);
  return dir === "/" ? null : dir;
}

/**
 * The rule content for a directory containment rule. The directory is absolute
 * and already starts with a slash, and such a rule is written `//dir/**` - two
 * slashes mean "absolute" - so the first slash must be dropped rather than
 * doubled. The CLI builds the same string for an absolute directory.
 */
function directoryRule(dir: string): string {
  return `//${dir.slice(1)}/**`;
}

/**
 * The first word of a shell command, when that word is a safe thing to
 * remember. Returns null for anything opaque, compound, or odd.
 */
function executableOf(command: string): string | null {
  const first = command.trim().split(/\s+/)[0] ?? "";
  if (!first || first.length > MAX_EXECUTABLE_LENGTH) return null;
  if (!EXECUTABLE.test(first)) return null;
  if (OPAQUE_COMMANDS.has(first)) return null;
  return first;
}

/** The bare hostname of a URL, without scheme, port or path. */
function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host || null;
  } catch {
    return null;
  }
}

/** Does this suggestion actually do something, and is it narrow enough? */
function isUsableSuggestion(rule: PermissionRuleValue): boolean {
  const content = rule.ruleContent;
  if (content === undefined || content === "") {
    return !WHOLE_TOOL_DANGER.has(rule.toolName);
  }
  if (content === WILDCARD || content.trim() === "") return false;

  switch (rule.toolName) {
    // Stored but never consulted, with or without content: the button would
    // look dead.
    case "Glob":
    case "Grep":
    case "Write":
    case "NotebookEdit":
      return false;
    case "WebFetch":
      // The CLI requires exactly "domain:<hostname>".
      return content.startsWith("domain:") && content.length > "domain:".length;
    case "Bash": {
      // An exact command (`npm run build`) is narrow by construction, but must
      // still be free of shell syntax.
      if (!content.endsWith(":*")) return !SHELL_SYNTAX.test(content);

      // A prefix is only as narrow as its first word. The CLI offers the
      // first TWO words, so a live gate for `sudo rm -rf /tmp/x` came with
      // `sudo rm:*` - which would remember exactly the kind of command this
      // module exists to refuse. Only a concrete executable goes through.
      const prefix = content.slice(0, -":*".length);
      return (
        prefix.length > 0 &&
        !SHELL_SYNTAX.test(prefix) &&
        executableOf(prefix) !== null
      );
    }
    case "Read":
    case "Edit":
      // Only the absolute directory form reads the way it looks. A rule path
      // with ONE leading slash is relative to the project root, so any other
      // shape could grant a directory other than the one it names.
      return content.startsWith("//") && content.endsWith("/**");
    default:
      return true;
  }
}

/**
 * Build the narrowest rule that still makes this gate go away next time.
 * Returns null when no safe rule exists for this tool and input.
 */
export function synthesizeRule(
  toolName: string,
  input: Record<string, unknown>
): PermissionRuleValue | null {
  switch (toolName) {
    case "Bash": {
      const command = asString(input.command);
      const executable = executableOf(command);
      if (!executable || SHELL_SYNTAX.test(command)) return null;
      return { toolName: "Bash", ruleContent: `${executable}:*` };
    }

    case "Read": {
      const dir = directoryOf(asString(input.file_path));
      return dir ? { toolName: "Read", ruleContent: directoryRule(dir) } : null;
    }

    case "Glob":
    case "Grep": {
      // `path` names the directory the search runs in, not a file inside it, so
      // the rule covers that directory itself.
      const dir = absoluteDirectory(asString(input.path));
      return dir ? { toolName: "Read", ruleContent: directoryRule(dir) } : null;
    }

    case "Write":
    case "Edit": {
      const dir = directoryOf(asString(input.file_path));
      return dir ? { toolName: "Edit", ruleContent: directoryRule(dir) } : null;
    }

    case "NotebookEdit": {
      const dir = directoryOf(asString(input.notebook_path));
      return dir ? { toolName: "Edit", ruleContent: directoryRule(dir) } : null;
    }

    case "WebFetch": {
      const host = hostOf(asString(input.url));
      return host ? { toolName: "WebFetch", ruleContent: `domain:${host}` } : null;
    }

    default:
      return null;
  }
}

/**
 * The `updatedPermissions` array for an always-allow tap, or `[]` when the
 * button must not be offered at all.
 *
 * The CLI's own suggestions win when they are usable, because the CLI knows
 * more about the request than this module does. Otherwise a narrow rule is
 * synthesised from the input.
 */
export function alwaysAllowUpdates(
  toolName: string,
  input: Record<string, unknown>,
  suggestions?: PermissionUpdate[]
): PermissionUpdate[] {
  const usable: PermissionRuleValue[] = [];

  for (const suggestion of suggestions ?? []) {
    // Only "addRules" updates are rules; anything else is not ours to replay.
    if (suggestion.type === "addRules") {
      for (const rule of suggestion.rules) {
        if (isUsableSuggestion(rule)) usable.push(rule);
      }
    }
  }

  if (!usable.length) {
    const synthesized = synthesizeRule(toolName, input);
    if (synthesized) usable.push(synthesized);
  }

  if (!usable.length) return [];

  return [
    {
      type: "addRules",
      rules: usable,
      behavior: "allow",
      destination: "session",
    },
  ];
}

function describeRule(rule: PermissionRuleValue): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
}

/** Cut a label to Telegram's button limit without splitting a surrogate pair. */
function fitLabel(text: string, maxLength: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxLength) return text;
  return characters.slice(0, maxLength - 1).join("") + "…";
}

/**
 * The ♾️ button label for a set of updates, showing what would be remembered:
 * `♾️ Always: Bash(ls:*)`. Returns null when there is nothing to offer.
 *
 * A single rule that does not fit keeps its content and loses only the tool
 * name, because `♾️ Always: WebFetch(domain:ex…` tells the user less than
 * `♾️ Always: domain:example.com` does. Everything longer still ends in an
 * ellipsis rather than lying about what fits.
 */
export function alwaysAllowLabel(updates: PermissionUpdate[]): string | null {
  const rules = updates.flatMap((update) =>
    update.type === "addRules" ? update.rules : []
  );
  if (!rules.length) return null;

  const [first, ...rest] = rules as [PermissionRuleValue, ...PermissionRuleValue[]];
  const summary =
    rest.length > 0
      ? `${describeRule(first)} +${rest.length}`
      : describeRule(first);

  const full = `♾️ Always: ${summary}`;
  if (Array.from(full).length <= BUTTON_LABEL_MAX_LENGTH) return full;

  if (rest.length === 0 && first.ruleContent) {
    const contentOnly = `♾️ Always: ${first.ruleContent}`;
    if (Array.from(contentOnly).length <= BUTTON_LABEL_MAX_LENGTH) {
      return contentOnly;
    }
  }

  return fitLabel(full, BUTTON_LABEL_MAX_LENGTH);
}

/** The same summary for the settled message: `Bash(ls:*)`. */
export function alwaysAllowSummary(updates: PermissionUpdate[]): string | null {
  const rules = updates.flatMap((update) =>
    update.type === "addRules" ? update.rules : []
  );
  if (!rules.length) return null;

  const [first, ...rest] = rules as [PermissionRuleValue, ...PermissionRuleValue[]];
  const summary =
    rest.length > 0 ? `${describeRule(first)} +${rest.length}` : describeRule(first);

  return summary;
}
