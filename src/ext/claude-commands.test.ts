import { describe, test, expect, beforeEach } from "bun:test";
import {
  buildCommandMenu,
  sanitizeCommandName,
  translateMenuCommand,
  updateClaudeCommands,
  _resetClaudeCommandsForTest,
  MAX_MENU_COMMANDS,
} from "./claude-commands";

beforeEach(() => {
  _resetClaudeCommandsForTest();
});

describe("sanitizeCommandName", () => {
  test("lowercases and replaces hyphens with underscores", () => {
    expect(sanitizeCommandName("mattpocock-skills")).toBe("mattpocock_skills");
  });

  test("strips other invalid characters", () => {
    expect(sanitizeCommandName("Foo.Bar!")).toBe("foo_bar");
  });

  test("returns null for empty, symbol-only, or over-length names", () => {
    expect(sanitizeCommandName("")).toBeNull();
    expect(sanitizeCommandName("!!!")).toBeNull();
    expect(sanitizeCommandName("a".repeat(33))).toBeNull();
  });
});

describe("buildCommandMenu", () => {
  test("with no harvested commands returns native commands only", () => {
    const menu = buildCommandMenu(null);
    const names = menu.map((e) => e.command);
    expect(names).toEqual(
      expect.arrayContaining(["new", "plan", "build", "help"])
    );
  });

  test("merges harvested slash commands and skills, excluding native collisions", () => {
    const menu = buildCommandMenu({
      slashCommands: ["init", "clear", "plan", "compact"],
      skills: ["caveman", "mattpocock-skills"],
    });
    const names = menu.map((e) => e.command);
    expect(names).toEqual(
      expect.arrayContaining([
        "init",
        "clear",
        "compact",
        "caveman",
        "mattpocock_skills",
      ])
    );
    // "plan" is a native bot command now — must not be duplicated/shadowed.
    expect(names.filter((n) => n === "plan").length).toBe(1);
  });

  test("skills are labelled distinctly from slash commands", () => {
    const menu = buildCommandMenu({
      slashCommands: ["init"],
      skills: ["caveman"],
    });
    expect(menu.find((e) => e.command === "caveman")?.description).toContain(
      "Skill"
    );
  });

  test("caps at Telegram's 100-command limit with native commands first", () => {
    const slashCommands = Array.from({ length: 200 }, (_, i) => `cmd${i}`);
    const menu = buildCommandMenu({ slashCommands, skills: [] });
    expect(menu.length).toBeLessThanOrEqual(MAX_MENU_COMMANDS);
    expect(menu[0]!.command).toBe("start");
  });
});

describe("updateClaudeCommands", () => {
  test("returns true only when the harvested set actually changes", () => {
    expect(updateClaudeCommands(["init"], ["caveman"])).toBe(true);
    expect(updateClaudeCommands(["init"], ["caveman"])).toBe(false);
    expect(updateClaudeCommands(["init", "clear"], ["caveman"])).toBe(true);
  });

  test("populates the sanitize map used for pass-through translation", () => {
    updateClaudeCommands([], ["mattpocock-skills"]);
    expect(translateMenuCommand("mattpocock_skills")).toBe("mattpocock-skills");
    expect(translateMenuCommand("unmapped")).toBe("unmapped");
  });
});
