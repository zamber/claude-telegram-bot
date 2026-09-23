/**
 * Rendering and answer collection for the built-in `AskUserQuestion` tool.
 *
 * Why this exists: the CLI gives AskUserQuestion `checkPermissions()` returning
 * {behavior:"ask"} plus `requiresUserInteraction()`, which short-circuits before
 * the bypassPermissions check. So the tool ALWAYS reaches our canUseTool callback
 * and headless mode has no terminal fallback. Without special handling the gate
 * showed only the bare tool name, and an "Allow" tap returned the input unchanged
 * with no `answers` - the CLI then ran the tool with `answers = {}` and told
 * Claude "User has answered your questions: ." (a real answer, but empty).
 *
 * The answer travels back inside the permission result's `updatedInput`, which
 * the CLI's can_use_tool schema validates only as a generic record (the tool's own
 * input schema has an optional `answers: Record<string,string>` keyed by question
 * text). That is the only channel - there is no separate control-request subtype
 * for questions.
 *
 * Everything here is pure so it can be unit-tested without a Bot API.
 */

import type { InlineKeyboardMarkup } from "grammy/types";
import { escapeHtml } from "../formatting";
import { BUTTON_LABEL_MAX_LENGTH, TELEGRAM_SAFE_LIMIT } from "../config";

/** One selectable option. The SDK shape uses label + description. */
export type AskOption = { label: string; description: string };

/** One question. 1-4 questions, 2-4 options each, per the CLI's schema. */
export type AskQuestion = {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect: boolean;
};

export type AskUserQuestionInput = {
  questions: AskQuestion[];
  answers?: Record<string, string>;
};

/** Per-request selection state, held in the pending permission entry. */
export type AskProgress = {
  /** question index -> chosen option indices */
  selected: Record<number, number[]>;
  /** question index -> user confirmed it */
  committed: Record<number, boolean>;
  /**
   * question index -> a free-text answer typed instead of tapping an option.
   * Optional so callers that only ever tap keep the two-field shape. A listed
   * option and free text are mutually exclusive for one question; free text
   * wins when both are somehow present.
   */
  freeText?: Record<number, string>;
};

export function newAskProgress(): AskProgress {
  return { selected: {}, committed: {} };
}

const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

/** Callback tag for the Cancel button. Colon-free so split(":") keeps its shape. */
export const ASK_CANCEL_TAG = "x";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate the tool input. Returns null when the shape is not what the tool's
 * own schema promises, so the caller can fall back to the generic gate.
 */
export function parseAskInput(
  input: Record<string, unknown>
): AskUserQuestionInput | null {
  const rawQuestions: unknown[] = Array.isArray(input.questions)
    ? (input.questions as unknown[])
    : [];
  if (rawQuestions.length < 1 || rawQuestions.length > MAX_QUESTIONS) {
    return null;
  }

  const questions: AskQuestion[] = [];
  const seenQuestionTexts = new Set<string>();

  for (const rawQuestion of rawQuestions) {
    if (!rawQuestion || typeof rawQuestion !== "object") return null;
    const candidate = rawQuestion as Record<string, unknown>;

    if (!isNonEmptyString(candidate.question)) return null;
    if (!isNonEmptyString(candidate.header)) return null;
    if (typeof candidate.multiSelect !== "boolean") return null;
    if (
      !Array.isArray(candidate.options) ||
      candidate.options.length < MIN_OPTIONS ||
      candidate.options.length > MAX_OPTIONS
    ) {
      return null;
    }

    const options: AskOption[] = [];
    const seenLabels = new Set<string>();
    for (const rawOption of candidate.options as unknown[]) {
      if (!rawOption || typeof rawOption !== "object") return null;
      const option = rawOption as Record<string, unknown>;
      if (!isNonEmptyString(option.label)) return null;
      if (!isNonEmptyString(option.description)) return null;
      const label = option.label.trim();
      // The tool's own schema requires unique labels within a question, and the
      // answer is keyed by question text, so both must be unique.
      if (seenLabels.has(label)) return null;
      seenLabels.add(label);
      options.push({ label, description: option.description.trim() });
    }

    const questionText = candidate.question.trim();
    if (seenQuestionTexts.has(questionText)) return null;
    seenQuestionTexts.add(questionText);

    questions.push({
      question: questionText,
      header: candidate.header.trim(),
      options,
      multiSelect: candidate.multiSelect,
    });
  }

  return { questions };
}

/** Truncate for display. Newlines collapse so a button label stays one line. */
function truncatePlain(text: string, maxLength: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength - 1) + "…";
}

function renderQuestion(
  question: AskQuestion,
  index: number,
  withDescriptions: boolean,
  maxQuestionLength: number
): string {
  const title = `${index + 1}. <b>${escapeHtml(
    truncatePlain(question.question, maxQuestionLength)
  )}</b>`;
  if (!withDescriptions) return title;

  const lines = question.options.map(
    (option) =>
      `   • <b>${escapeHtml(truncatePlain(option.label, 60))}</b> — ${escapeHtml(
        truncatePlain(option.description, 160)
      )}`
  );
  return [title, ...lines].join("\n");
}

/**
 * Render the question set as Telegram HTML, within one message.
 *
 * The gate settles by editing ONE message, so this must never overflow into a
 * second message. Degrade in order: drop the option description lines, then
 * shorten the questions, then hard-slice.
 */
export function renderAskPrompt(questions: AskQuestion[]): string {
  const header = "❓ <b>Claude asks:</b>";
  const howTo = questions.some((question) => question.multiSelect)
    ? "Tap an option to answer. Multi-select questions need ✅ Done."
    : "Tap an option to answer.";
  // A typed message answers the next unanswered question too (see
  // resolvePendingText in ./permissions), so the card says so.
  const hint = `${howTo} You can also send your own answer as a message, or reply "cancel".`;

  const build = (withDescriptions: boolean, maxQuestionLength: number): string => {
    const blocks = questions.map((question, index) =>
      renderQuestion(question, index, withDescriptions, maxQuestionLength)
    );
    return [header, blocks.join("\n\n"), hint].join("\n\n");
  };

  const full = build(true, 400);
  if (full.length <= TELEGRAM_SAFE_LIMIT) return full;

  const withoutDescriptions = build(false, 400);
  if (withoutDescriptions.length <= TELEGRAM_SAFE_LIMIT) return withoutDescriptions;

  const short = build(false, 120);
  if (short.length <= TELEGRAM_SAFE_LIMIT) return short;

  return short.slice(0, TELEGRAM_SAFE_LIMIT);
}

export function encodeOptionTag(questionIndex: number, optionIndex: number): string {
  return `o${questionIndex}${optionIndex}`;
}

export function encodeDoneTag(questionIndex: number): string {
  return `D${questionIndex}`;
}

/**
 * Build the option keyboard. `callbackPrefix` is "perm:<requestId>:", passed in
 * by permissions.ts so this module never has to import it (which would be a
 * cycle).
 */
export function buildAskKeyboard(
  callbackPrefix: string,
  questions: AskQuestion[],
  selected: Record<number, number[]>
): InlineKeyboardMarkup {
  const rows: { text: string; callback_data: string }[][] = [];

  questions.forEach((question, questionIndex) => {
    question.options.forEach((option, optionIndex) => {
      const chosen = (selected[questionIndex] ?? []).includes(optionIndex);
      // Number the options only when there is more than one question, so a
      // single question keeps the widest possible labels.
      const prefix =
        questions.length > 1 ? `${questionIndex + 1}.${optionIndex + 1} ` : "";
      const marker = question.multiSelect ? (chosen ? "☑ " : "☐ ") : "";
      rows.push([
        {
          text: truncatePlain(
            `${marker}${prefix}${option.label}`,
            BUTTON_LABEL_MAX_LENGTH
          ),
          callback_data: `${callbackPrefix}${encodeOptionTag(
            questionIndex,
            optionIndex
          )}`,
        },
      ]);
    });

    if (question.multiSelect) {
      rows.push([
        {
          text: "✅ Done",
          callback_data: `${callbackPrefix}${encodeDoneTag(questionIndex)}`,
        },
      ]);
    }
  });

  rows.push([
    { text: "⛔ Cancel", callback_data: `${callbackPrefix}${ASK_CANCEL_TAG}` },
  ]);

  return { inline_keyboard: rows };
}

export type AskTag =
  | { kind: "option"; question: number; option: number }
  | { kind: "done"; question: number }
  | { kind: "cancel" };

const OPTION_TAG = /^o([0-3])([0-3])$/;
const DONE_TAG = /^D([0-3])$/;

export function parseAskTag(tag: string): AskTag | null {
  const optionMatch = OPTION_TAG.exec(tag);
  if (optionMatch) {
    return {
      kind: "option",
      question: Number(optionMatch[1]),
      option: Number(optionMatch[2]),
    };
  }

  const doneMatch = DONE_TAG.exec(tag);
  if (doneMatch) return { kind: "done", question: Number(doneMatch[1]) };

  if (tag === ASK_CANCEL_TAG) return { kind: "cancel" };

  return null;
}

export type AskTapResult =
  | { action: "cancel" }
  | { action: "update"; progress: AskProgress }
  | {
      action: "settle";
      progress: AskProgress;
      answers: Record<string, string>;
      note: string;
    };

/**
 * Apply one tap. Returns null when the tag cannot apply to this question set
 * (so the caller can report an invalid choice without changing state).
 */
export function applyAskTap(
  questions: AskQuestion[],
  progress: AskProgress,
  tag: AskTag
): AskTapResult | null {
  if (tag.kind === "cancel") return { action: "cancel" };

  const question = questions[tag.question];
  if (!question) return null;

  const selected: Record<number, number[]> = { ...progress.selected };
  const committed: Record<number, boolean> = { ...progress.committed };

  if (tag.kind === "option") {
    if (!question.options[tag.option]) return null;

    if (question.multiSelect) {
      const current = selected[tag.question] ?? [];
      selected[tag.question] = current.includes(tag.option)
        ? current.filter((index) => index !== tag.option)
        : [...current, tag.option].sort((a, b) => a - b);
    } else {
      selected[tag.question] = [tag.option];
      committed[tag.question] = true;
    }
  } else {
    // "Done" commits a multi-select question; it needs at least one choice.
    if (!question.multiSelect) return null;
    if (!(selected[tag.question] ?? []).length) return null;
    committed[tag.question] = true;
  }

  const next: AskProgress = { selected, committed };
  const allAnswered = questions.every((_, index) => committed[index] === true);

  if (allAnswered) {
    return {
      action: "settle",
      progress: next,
      answers: buildAnswers(questions, next),
      note: askSettleNote(questions, next),
    };
  }

  return { action: "update", progress: next };
}

/** Answers keyed by question text - the shape the CLI expects. */
export function buildAnswers(
  questions: AskQuestion[],
  progress: AskProgress
): Record<string, string> {
  const answers: Record<string, string> = {};

  questions.forEach((question, questionIndex) => {
    const typed = progress.freeText?.[questionIndex];
    if (typed) {
      answers[question.question] = typed;
      return;
    }
    const labels = (progress.selected[questionIndex] ?? [])
      .map((optionIndex) => question.options[optionIndex]?.label)
      .filter((label): label is string => Boolean(label));
    if (labels.length) answers[question.question] = labels.join(", ");
  });

  return answers;
}

/** Human-readable summary of what was answered, for the settled message. */
export function askSettleNote(
  questions: AskQuestion[],
  progress: AskProgress
): string {
  const answers = buildAnswers(questions, progress);

  if (questions.length === 1) {
    return `✅ Answered: ${answers[questions[0]!.question] ?? "—"}`;
  }

  return questions
    .map(
      (question, index) =>
        `${index + 1}. ${answers[question.question] ?? "—"}`
    )
    .join("\n");
}
