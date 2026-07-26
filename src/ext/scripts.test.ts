import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import {
  findScript,
  tokenizeArgs,
  runScript,
  type ScriptDef,
} from "./scripts";

const FIXTURES = resolve(import.meta.dir, "__fixtures__");

function def(name: string, overrides: Partial<ScriptDef> = {}): ScriptDef {
  return {
    name,
    path: `${FIXTURES}/${name}.sh`,
    description: "test fixture",
    ...overrides,
  };
}

describe("tokenizeArgs", () => {
  test("splits on whitespace", () => {
    expect(tokenizeArgs("a b c")).toEqual(["a", "b", "c"]);
  });

  test("collapses repeated whitespace", () => {
    expect(tokenizeArgs("a   b")).toEqual(["a", "b"]);
  });

  test("keeps a double-quoted arg with spaces as one token", () => {
    expect(tokenizeArgs('"hello world" b')).toEqual(["hello world", "b"]);
  });

  test("keeps a single-quoted arg with spaces as one token", () => {
    expect(tokenizeArgs("'hello world' b")).toEqual(["hello world", "b"]);
  });

  test("supports an escaped quote inside a quoted arg", () => {
    expect(tokenizeArgs('"say \\"hi\\""')).toEqual(['say "hi"']);
  });

  test("empty input yields no args", () => {
    expect(tokenizeArgs("")).toEqual([]);
    expect(tokenizeArgs("   ")).toEqual([]);
  });
});

describe("findScript", () => {
  const list = [def("echo-args"), def("sleep-script")];

  test("finds by exact name", () => {
    expect(findScript(list, "echo-args")?.name).toBe("echo-args");
  });

  test("returns undefined for an unknown name", () => {
    expect(findScript(list, "not-configured")).toBeUndefined();
  });

  test("does not resolve a path passed as the name", () => {
    // Only the configured `name` key is ever looked up - a value like
    // "../../etc/passwd" is just a string that won't match any entry.
    expect(findScript(list, "../../etc/passwd")).toBeUndefined();
  });
});

describe("runScript", () => {
  test("passes argv literally, never shell-interpreted", async () => {
    const result = await runScript(def("echo-args"), [
      "; rm -rf /",
      "$(whoami)",
      "a b",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "ARG:; rm -rf /\nARG:$(whoami)\nARG:a b\n"
    );
  });

  test("captures a non-zero exit code", async () => {
    const result = await runScript(def("exit-code"), ["7"]);
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  test("truncates output beyond the configured cap", async () => {
    const result = await runScript(def("big-output"), []);
    // big-output.sh emits 10000 'x' chars + newline; default cap is 3500.
    expect(result.stdout.length).toBeLessThan(10001);
    expect(result.stdout).toContain("[truncated]");
  });

  test("kills the process and reports timedOut when it exceeds timeoutMs", async () => {
    const result = await runScript(
      def("sleep-script", { timeoutMs: 300 }),
      ["5"]
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).not.toContain("woke up");
  }, 2000);
});
