import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getMappedSessionId,
  setMappedSessionId,
  _resetSessionMapForTest,
} from "./session-map";

describe("session-map", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-map-test-"));
    process.env.SESSION_MAP_FILE = join(dir, "map.json");
    process.env.SESSION_FILE = join(dir, "history.json");
    _resetSessionMapForTest();
  });

  afterEach(() => {
    delete process.env.SESSION_MAP_FILE;
    delete process.env.SESSION_FILE;
    _resetSessionMapForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns null for an unknown key", () => {
    expect(getMappedSessionId("default")).toBeNull();
  });

  test("set then get returns the value", () => {
    setMappedSessionId("123:45", "sess-abc");
    expect(getMappedSessionId("123:45")).toBe("sess-abc");
  });

  test("set null clears the binding", () => {
    setMappedSessionId("123:45", "sess-abc");
    setMappedSessionId("123:45", null);
    expect(getMappedSessionId("123:45")).toBeNull();
  });

  test("survives a simulated restart (in-memory cache dropped)", () => {
    setMappedSessionId("123:45", "sess-abc");
    _resetSessionMapForTest(); // what a process restart effectively does
    expect(getMappedSessionId("123:45")).toBe("sess-abc");
  });

  test("missing file yields null", () => {
    // Nothing has written map.json in this test yet.
    expect(getMappedSessionId("default")).toBeNull();
  });

  test("corrupt file yields null", () => {
    writeFileSync(join(dir, "map.json"), "not json", "utf-8");
    _resetSessionMapForTest();
    expect(getMappedSessionId("default")).toBeNull();
  });

  test("keeps separate entries per thread key", () => {
    setMappedSessionId("123:1", "sess-a");
    setMappedSessionId("123:2", "sess-b");
    expect(getMappedSessionId("123:1")).toBe("sess-a");
    expect(getMappedSessionId("123:2")).toBe("sess-b");
  });

  test("backfills from session history when the map file is missing (upgrade path)", () => {
    // Existing history, ordered most-recent-first like saveSession writes it.
    writeFileSync(
      join(dir, "history.json"),
      JSON.stringify({
        sessions: [
          {
            session_id: "sess-recent",
            session_key: "123:45",
            working_dir: "/home/luna",
            title: "Recent",
            saved_at: new Date().toISOString(),
          },
          {
            session_id: "sess-old",
            session_key: "123:45",
            working_dir: "/home/luna",
            title: "Old",
            saved_at: new Date().toISOString(),
          },
          {
            // No session_key → the "default" thread.
            session_id: "sess-default",
            working_dir: "/home/luna",
            title: "Default",
            saved_at: new Date().toISOString(),
          },
        ],
      }),
      "utf-8"
    );
    _resetSessionMapForTest();

    expect(getMappedSessionId("123:45")).toBe("sess-recent");
    expect(getMappedSessionId("default")).toBe("sess-default");
  });

  test("a missing map file does not resurrect a session that was cleared to null", () => {
    // The map exists with an explicit null (what /new writes)…
    setMappedSessionId("123:45", null);
    _resetSessionMapForTest();

    // …and the history still contains that same thread's old session.
    writeFileSync(
      join(dir, "history.json"),
      JSON.stringify({
        sessions: [
          {
            session_id: "sess-old",
            session_key: "123:45",
            working_dir: "/home/luna",
            title: "Old",
            saved_at: new Date().toISOString(),
          },
        ],
      }),
      "utf-8"
    );

    // Because the map file already exists, no backfill runs: the explicit
    // "cleared" binding wins over the stale history entry.
    expect(getMappedSessionId("123:45")).toBeNull();
  });
});
