import { describe, test, expect } from "bun:test";
import { TELEGRAM_SAFE_LIMIT } from "../config";
import {
  ASK_CANCEL_TAG,
  applyAskTap,
  askSettleNote,
  buildAnswers,
  buildAskKeyboard,
  encodeDoneTag,
  encodeOptionTag,
  newAskProgress,
  parseAskInput,
  parseAskTag,
  renderAskPrompt,
  type AskProgress,
  type AskQuestion,
} from "./ask-question";

/** One question with `count` options, labelled A, B, C, D. */
function question(
  text: string,
  count = 2,
  multiSelect = false
): AskQuestion {
  return {
    question: text,
    header: "Header",
    options: Array.from({ length: count }, (_, index) => ({
      label: String.fromCharCode(65 + index),
      description: `description ${index}`,
    })),
    multiSelect,
  };
}

/** Every callback_data in a keyboard, in row order. */
function callbackDataOf(
  markup: ReturnType<typeof buildAskKeyboard>
): string[] {
  return markup.inline_keyboard
    .flat()
    .map((button) => ("callback_data" in button ? button.callback_data : ""));
}

/** Narrow a tap result to the variants that carry progress. */
function progressed(
  result: ReturnType<typeof applyAskTap>
): { progress: AskProgress } {
  if (!result || result.action === "cancel") {
    throw new Error(`expected a tap that carries progress, got ${result}`);
  }
  return result;
}

function rawQuestion(
  text: string,
  count = 2,
  multiSelect = false
): Record<string, unknown> {
  return {
    question: text,
    header: "Header",
    multiSelect,
    options: Array.from({ length: count }, (_, index) => ({
      label: String.fromCharCode(65 + index),
      description: `description ${index}`,
    })),
  };
}

describe("parseAskInput", () => {
  test("accepts a well-formed question set and trims it", () => {
    const parsed = parseAskInput({
      questions: [rawQuestion("  Pick one  ")],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.questions).toHaveLength(1);
    expect(parsed!.questions[0]!.question).toBe("Pick one");
    expect(parsed!.questions[0]!.options[0]).toEqual({
      label: "A",
      description: "description 0",
    });
  });

  test("rejects an empty, oversized or malformed set", () => {
    expect(parseAskInput({ questions: [] })).toBeNull();
    expect(parseAskInput({})).toBeNull();
    expect(
      parseAskInput({
        questions: Array.from({ length: 5 }, (_, i) => rawQuestion(`q${i}`)),
      })
    ).toBeNull();
  });

  test("rejects a question with too few or too many options", () => {
    expect(parseAskInput({ questions: [rawQuestion("q", 1)] })).toBeNull();
    expect(parseAskInput({ questions: [rawQuestion("q", 5)] })).toBeNull();
  });

  test("rejects duplicate question text and duplicate labels", () => {
    expect(
      parseAskInput({ questions: [rawQuestion("same"), rawQuestion("same")] })
    ).toBeNull();

    const duplicated = rawQuestion("q");
    (duplicated.options as { label: string }[])[1]!.label = "A";
    expect(parseAskInput({ questions: [duplicated] })).toBeNull();
  });

  test("rejects blank text and a non-boolean multiSelect", () => {
    expect(
      parseAskInput({ questions: [{ ...rawQuestion("q"), question: "   " }] })
    ).toBeNull();
    expect(
      parseAskInput({ questions: [{ ...rawQuestion("q"), header: "" }] })
    ).toBeNull();
    expect(
      parseAskInput({
        questions: [{ ...rawQuestion("q"), multiSelect: "yes" }],
      })
    ).toBeNull();
  });
});

describe("renderAskPrompt", () => {
  test("renders the question, its options and the answer hint", () => {
    const html = renderAskPrompt([question("Pick one")]);
    expect(html).toContain("Claude asks");
    expect(html).toContain("1. <b>Pick one</b>");
    expect(html).toContain("<b>A</b> — description 0");
    expect(html).toContain("Tap an option to answer.");
  });

  test("mentions the Done button only when a question is multi-select", () => {
    expect(renderAskPrompt([question("Pick one")])).not.toContain("✅ Done");
    expect(renderAskPrompt([question("Pick many", 3, true)])).toContain(
      "✅ Done"
    );
  });

  test("escapes question and option text", () => {
    const html = renderAskPrompt([
      {
        question: "<b>not bold</b>",
        header: "H",
        options: [
          { label: "<i>x</i>", description: "a & b" },
          { label: "B", description: "c" },
        ],
        multiSelect: false,
      },
    ]);
    expect(html).not.toContain("<b>not bold</b>");
    expect(html).toContain("&lt;b&gt;not bold&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;x&lt;/i&gt;");
    expect(html).toContain("a &amp; b");
  });

  test("stays within one Telegram message at the maximum size", () => {
    const questions = Array.from({ length: 4 }, (_, i) => ({
      question: "Q".repeat(400) + i,
      header: "Header",
      options: Array.from({ length: 4 }, (_, j) => ({
        label: `Option ${i}-${j}`,
        description: "D".repeat(200),
      })),
      multiSelect: true,
    }));

    expect(renderAskPrompt(questions).length).toBeLessThanOrEqual(
      TELEGRAM_SAFE_LIMIT
    );
  });
});

describe("buildAskKeyboard", () => {
  test("gives every option a row and always offers Cancel", () => {
    const markup = buildAskKeyboard("perm:abc12345:", [question("Pick one")], {});
    const flat = markup.inline_keyboard.flat();
    expect(flat.map((b) => b.text)).toEqual(["A", "B", "⛔ Cancel"]);
    expect(callbackDataOf(markup)).toEqual([
      "perm:abc12345:o00",
      "perm:abc12345:o01",
      "perm:abc12345:x",
    ]);
  });

  test("numbers options and adds a Done row for multi-select questions", () => {
    const markup = buildAskKeyboard(
      "perm:abc12345:",
      [question("Pick one"), question("Pick many", 3, true)],
      {}
    );
    const flat = markup.inline_keyboard.flat();
    expect(flat.map((b) => b.text)).toEqual([
      "1.1 A",
      "1.2 B",
      "☐ 2.1 A",
      "☐ 2.2 B",
      "☐ 2.3 C",
      "✅ Done",
      "⛔ Cancel",
    ]);
  });

  test("marks the selected options of a multi-select question", () => {
    const markup = buildAskKeyboard(
      "perm:abc12345:",
      [question("Pick many", 3, true)],
      { 0: [0, 2] }
    );
    const labels = markup.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toEqual(["☑ A", "☐ B", "☑ C", "✅ Done", "⛔ Cancel"]);
  });

  test("keeps callback_data well under Telegram's 64-byte cap", () => {
    const markup = buildAskKeyboard(
      `perm:${"f".repeat(8)}:`,
      Array.from({ length: 4 }, (_, i) => question(`q${i}`, 4)),
      {}
    );
    for (const data of callbackDataOf(markup)) {
      expect(data.length).toBeLessThanOrEqual(64);
    }
  });
});

describe("parseAskTag", () => {
  test("round-trips the encoded tags", () => {
    expect(parseAskTag(encodeOptionTag(2, 3))).toEqual({
      kind: "option",
      question: 2,
      option: 3,
    });
    expect(parseAskTag(encodeDoneTag(1))).toEqual({ kind: "done", question: 1 });
    expect(parseAskTag(ASK_CANCEL_TAG)).toEqual({ kind: "cancel" });
  });

  test("rejects out-of-range, decision and malformed tags", () => {
    expect(parseAskTag("o44")).toBeNull();
    expect(parseAskTag("D4")).toBeNull();
    expect(parseAskTag("a")).toBeNull();
    expect(parseAskTag("o0")).toBeNull();
    expect(parseAskTag("")).toBeNull();
  });

  test("does not collide with the decision letters", () => {
    for (const code of ["a", "w", "d"]) {
      expect(parseAskTag(code)).toBeNull();
    }
  });
});

describe("applyAskTap", () => {
  test("a single tap commits a single-select question", () => {
    const questions = [question("Pick one")];
    const outcome = applyAskTap(questions, newAskProgress(), {
      kind: "option",
      question: 0,
      option: 1,
    });
    expect(outcome).toEqual({
      action: "settle",
      progress: { selected: { 0: [1] }, committed: { 0: true } },
      answers: { "Pick one": "B" },
      note: "✅ Answered: B",
    });
  });

  test("a multi-select question toggles, then commits on Done", () => {
    const questions = [question("Pick many", 3, true)];
    const first = applyAskTap(questions, newAskProgress(), {
      kind: "option",
      question: 0,
      option: 0,
    });
    expect(first).toMatchObject({ action: "update" });

    const second = applyAskTap(questions, progressed(first).progress, {
      kind: "option",
      question: 0,
      option: 2,
    });
    expect(second).toMatchObject({ action: "update" });

    const done = applyAskTap(questions, progressed(second).progress, {
      kind: "done",
      question: 0,
    });
    expect(done).toEqual({
      action: "settle",
      progress: { selected: { 0: [0, 2] }, committed: { 0: true } },
      answers: { "Pick many": "A, C" },
      note: "✅ Answered: A, C",
    });
  });

  test("toggling an option off before Done removes it", () => {
    const questions = [question("Pick many", 3, true)];
    const on = applyAskTap(questions, newAskProgress(), {
      kind: "option",
      question: 0,
      option: 1,
    });
    const off = applyAskTap(questions, progressed(on).progress, {
      kind: "option",
      question: 0,
      option: 1,
    });
    expect(off).toMatchObject({ action: "update" });
    expect(progressed(off).progress.selected[0]).toEqual([]);
  });

  test("a multi-question set settles only after every question is committed", () => {
    const questions = [question("First"), question("Second")];

    const partial = applyAskTap(questions, newAskProgress(), {
      kind: "option",
      question: 0,
      option: 0,
    });
    expect(partial).toMatchObject({ action: "update" });

    const settled = applyAskTap(questions, progressed(partial).progress, {
      kind: "option",
      question: 1,
      option: 1,
    });
    if (settled?.action !== "settle") throw new Error("expected a settle");
    expect(settled.answers).toEqual({ First: "A", Second: "B" });
    expect(settled.note).toBe("1. A\n2. B");
  });

  test("Cancel is always accepted", () => {
    expect(
      applyAskTap([question("q")], newAskProgress(), { kind: "cancel" })
    ).toEqual({ action: "cancel" });
  });

  test("rejects a tap that cannot apply", () => {
    const questions = [question("q")];
    // Option index past the end of the question.
    expect(
      applyAskTap(questions, newAskProgress(), {
        kind: "option",
        question: 0,
        option: 3,
      })
    ).toBeNull();
    // Question index past the end of the set.
    expect(
      applyAskTap(questions, newAskProgress(), {
        kind: "option",
        question: 3,
        option: 0,
      })
    ).toBeNull();
    // Done on a single-select question is meaningless.
    expect(
      applyAskTap(questions, newAskProgress(), { kind: "done", question: 0 })
    ).toBeNull();
    // Done on an empty multi-select question commits nothing.
    expect(
      applyAskTap([question("q", 2, true)], newAskProgress(), {
        kind: "done",
        question: 0,
      })
    ).toBeNull();
  });
});

describe("buildAnswers / askSettleNote", () => {
  test("keys answers by question text and omits unanswered questions", () => {
    const answers = buildAnswers([question("First"), question("Second")], {
      selected: { 0: [0] },
      committed: { 0: true },
    });
    expect(answers).toEqual({ First: "A" });
  });

  test("numbers the note for a multi-question set", () => {
    expect(
      askSettleNote([question("First"), question("Second")], {
        selected: { 0: [0] },
        committed: { 0: true },
      })
    ).toBe("1. A\n2. —");
  });
});
