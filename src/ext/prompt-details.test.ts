import { describe, test, expect } from "bun:test";
import { escapeTruncate, describeGate } from "./prompt-details";

describe("escapeTruncate", () => {
  test("escapes the characters that would break Telegram HTML", () => {
    expect(escapeTruncate("<b>&</b>", 100)).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
  });

  test("counts the escaped length, not the raw length", () => {
    // Each "&" becomes 5 characters, so only two fit in a budget of 11.
    expect(escapeTruncate("&&&&", 11)).toBe("&amp;&amp;…");
  });

  test("never leaves half an entity behind", () => {
    const result = escapeTruncate("&&&&", 7);
    expect(result).toBe("&amp;…");
    expect(result).not.toContain("&am…");
  });

  test("leaves short text alone", () => {
    expect(escapeTruncate("ls -la", 100)).toBe("ls -la");
  });
});

describe("describeGate", () => {
  test("a Bash gate shows the whole command, description or not", () => {
    const details = describeGate("Bash", {
      command: "npm run build -- --watch",
      description: "Build it",
    });
    expect(details.preview).toBe("<pre>npm run build -- --watch</pre>");
  });

  test("a Bash gate quotes the safety verdict as the reason", () => {
    const details = describeGate("Bash", { command: "sudo rm /tmp/x" });
    expect(details.risk).toBe("Blocked pattern: sudo rm");
  });

  test("a Bash gate reports whichever pattern matched first", () => {
    // "rm -rf /" is listed before "sudo rm" in BLOCKED_PATTERNS and the check
    // is a substring test, so the more specific sudo pattern loses here.
    const details = describeGate("Bash", { command: "sudo rm -rf /tmp/x" });
    expect(details.risk).toBe("Blocked pattern: rm -rf /");
  });

  test("a blocked path outranks every other reason", () => {
    const details = describeGate(
      "Read",
      { file_path: "/etc/shadow" },
      {
        decisionReason: "Needs approval",
        blockedPath: "/etc/shadow",
      }
    );
    expect(details.risk).toBe(
      "Path is outside the allowed directories: /etc/shadow"
    );
  });

  test("falls back to the CLI's own wording", () => {
    const details = describeGate(
      "Read",
      { file_path: "/home/luna/x" },
      { decisionReason: "Not in the allowlist" }
    );
    expect(details.risk).toBe("Not in the allowlist");
  });

  test("omits the reason when there is none to show", () => {
    expect(describeGate("Read", { file_path: "/home/luna/x" }).risk).toBeUndefined();
  });

  test("an Edit gate shows the path and the line counts", () => {
    const details = describeGate("Edit", {
      file_path: "/home/luna/notes.md",
      old_string: "a\nb",
      new_string: "a\nb\nc",
    });
    expect(details.preview).toContain("<code>/home/luna/notes.md</code>");
    expect(details.preview).toContain("<code>+3 -2</code>");
  });

  test("an Edit gate with no diff shows only the path", () => {
    const details = describeGate("Edit", { file_path: "/home/luna/notes.md" });
    expect(details.preview).toBe("<code>/home/luna/notes.md</code>");
  });

  test("a Write gate shows the line count of the new content", () => {
    const details = describeGate("Write", {
      file_path: "/home/luna/new.md",
      content: "one\ntwo\nthree",
    });
    expect(details.preview).toContain("<code>3 lines</code>");
  });

  test("a Read gate shows the byte range when one is asked for", () => {
    const details = describeGate("Read", {
      file_path: "/home/luna/x",
      offset: 10,
      limit: 50,
    });
    expect(details.preview).toContain("<code>10–50</code>");
  });

  test("a Grep gate shows the pattern and the directory", () => {
    const details = describeGate("Grep", {
      pattern: "todo",
      path: "/home/luna/projects",
    });
    expect(details.preview).toBe(
      "<code>todo</code> in <code>/home/luna/projects</code>"
    );
  });

  test("a WebFetch gate shows the url", () => {
    const details = describeGate("WebFetch", { url: "https://example.com/a?b=c" });
    expect(details.preview).toBe("<code>https://example.com/a?b=c</code>");
  });

  test("an unknown tool dumps its input as escaped JSON", () => {
    const details = describeGate("SomeNewTool", { query: "<script>" });
    expect(details.preview).toContain("&lt;script&gt;");
    expect(details.preview).not.toContain("<script>");
  });

  test("an unserializable input still produces a preview", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const details = describeGate("SomeNewTool", cyclic);
    expect(details.preview).toBe("<pre>&lt;unserializable input&gt;</pre>");
  });

  test("a huge command is cut to a bounded preview", () => {
    const details = describeGate("Bash", { command: "x".repeat(50_000) });
    expect(details.preview!.length).toBeLessThan(900);
    expect(details.preview!.endsWith("…</pre>")).toBe(true);
  });
});
