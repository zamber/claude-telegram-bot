import { describe, test, expect } from "bun:test";
import { homedir } from "os";
import {
  extractSlugFromTranscript,
  sessionTranscriptPath,
  titleFromSlug,
} from "./session-title";
import { WORKING_DIR } from "../config";

describe("extractSlugFromTranscript", () => {
  test("returns the slug from a complete JSON line", () => {
    const line = JSON.stringify({
      type: "user",
      message: { slug: "smooth-swinging-fountain", cwd: "/home/luna" },
    });
    expect(extractSlugFromTranscript(line)).toBe("smooth-swinging-fountain");
  });

  test("scans backward so a trailing partial line does not hide a slug", () => {
    const complete = JSON.stringify({
      type: "user",
      message: { slug: "quick-bronze-fox", cwd: "/home/luna" },
    });
    const text = `${complete}\n${JSON.stringify({ type: "user" }).slice(0, 20)}`;
    expect(extractSlugFromTranscript(text)).toBe("quick-bronze-fox");
  });

  test("returns the LAST slug when several sessions share a transcript", () => {
    const a = JSON.stringify({ type: "user", message: { slug: "aaa" } });
    const b = JSON.stringify({ type: "user", message: { slug: "bbb" } });
    expect(extractSlugFromTranscript(`${a}\n${b}`)).toBe("bbb");
  });

  test("returns null when no slug is present", () => {
    expect(extractSlugFromTranscript("no slug here\n")).toBeNull();
    expect(extractSlugFromTranscript("")).toBeNull();
  });
});

describe("titleFromSlug", () => {
  test("converts kebab-case to Title Case", () => {
    expect(titleFromSlug("smooth-swinging-fountain")).toBe(
      "Smooth Swinging Fountain"
    );
  });

  test("handles single words and numbers", () => {
    expect(titleFromSlug("hello")).toBe("Hello");
    expect(titleFromSlug("topic-42")).toBe("Topic 42");
  });

  test("handles underscores and mixed separators", () => {
    expect(titleFromSlug("quick_bronze_fox")).toBe("Quick Bronze Fox");
    expect(titleFromSlug("a--b__c")).toBe("A B C");
  });

  test("caps the result at 128 characters", () => {
    const long = titleFromSlug(`${"word-".repeat(100)}tail`);
    expect(long.length).toBeLessThanOrEqual(128);
  });
});

describe("sessionTranscriptPath", () => {
  test("encodes cwd with hyphens and appends the session id", () => {
    const encodedCwd = WORKING_DIR.replace(/\//g, "-");
    const path = sessionTranscriptPath("abc123");
    expect(path).toBe(
      `${homedir()}/.claude/projects/${encodedCwd}/abc123.jsonl`
    );
  });
});
