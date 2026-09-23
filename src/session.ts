/**
 * Session management for Claude Telegram Bot.
 *
 * ClaudeSession class manages Claude Code sessions using the Agent SDK V1.
 * V1 supports full options (cwd, mcpServers, settingSources, etc.)
 */

import {
  query,
  type CanUseTool,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import type { Context } from "grammy";
import {
  ALLOWED_PATHS,
  MCP_SERVERS,
  PERMISSION_PROMPTS,
  SAFETY_PROMPT,
  SESSION_FILE,
  STREAMING_THROTTLE_MS,
  TEMP_PATHS,
  THINKING_DEEP_KEYWORDS,
  THINKING_KEYWORDS,
  WORKING_DIR,
} from "./config";
import { requestPermission } from "./ext/permissions";
import { formatToolStatus } from "./formatting";
import {
  checkPendingAskUserRequests,
  checkPendingSendFileRequests,
} from "./handlers/streaming";
import { checkCommandSafety, isPathAllowed } from "./security";
import { updateClaudeCommands } from "./ext/claude-commands";
import {
  getMappedSessionId,
  setMappedSessionId,
} from "./ext/session-map";
import type {
  SavedSession,
  SessionHistory,
  StatusCallback,
  TokenUsage,
} from "./types";

/**
 * Determine thinking token budget based on message keywords.
 */
function getThinkingLevel(message: string): number {
  const msgLower = message.toLowerCase();

  // Check deep thinking triggers first (more specific)
  if (THINKING_DEEP_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 50000;
  }

  // Check normal thinking triggers
  if (THINKING_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 10000;
  }

  // Default: no thinking
  return 0;
}

/**
 * Extract text content from SDK message.
 */
function getTextFromMessage(msg: SDKMessage): string | null {
  if (msg.type !== "assistant") return null;

  const textParts: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    }
  }
  return textParts.length > 0 ? textParts.join("") : null;
}

/**
 * Manages Claude Code sessions using the Agent SDK V1.
 */
// Maximum number of sessions to keep in history
const MAX_SESSIONS = 5;

/**
 * Path to the session history file. Env override exists so tests can isolate
 * themselves from the live bot's /tmp state.
 */
function historyFilePath(): string {
  return process.env.SESSION_FILE || SESSION_FILE;
}

/**
 * Bot-side allowlist consulted by canUseTool. Auto-allow the calls the bot
 * already trusted (its own MCP UI helpers, todo bookkeeping, commands that
 * pass checkCommandSafety, file access inside ALLOWED_PATHS). Everything else
 * returns false and becomes an inline-keyboard question in the chat.
 *
 * This is the pre-flight twin of the post-hoc guard further down: that guard
 * only runs when canUseTool is absent (PERMISSION_PROMPTS=false).
 */
function isToolAutoAllowed(
  toolName: string,
  input: Record<string, unknown>
): boolean {
  // Bot-owned MCP UI tools and harmless bookkeeping never need approval.
  if (
    toolName.startsWith("mcp__ask-user") ||
    toolName.startsWith("mcp__send-file") ||
    toolName === "TodoWrite"
  ) {
    return true;
  }

  if (toolName === "Bash") {
    return checkCommandSafety(String(input.command || ""))[0];
  }

  if (
    toolName === "Read" ||
    toolName === "Write" ||
    toolName === "Edit" ||
    toolName === "NotebookEdit"
  ) {
    const filePath = String(input.file_path || input.notebook_path || "");
    if (!filePath) return false;
    const isTmpRead =
      toolName === "Read" &&
      (TEMP_PATHS.some((p) => filePath.startsWith(p)) ||
        filePath.includes("/.claude/"));
    return isTmpRead || isPathAllowed(filePath);
  }

  if (toolName === "Glob" || toolName === "Grep") {
    const target = input.path ? String(input.path) : "";
    // No path means the tool defaults to the working dir, which is allowed.
    return !target || isPathAllowed(target);
  }

  return false;
}

export class ClaudeSession {
  sessionId: string | null = null;
  lastActivity: Date | null = null;
  queryStarted: Date | null = null;
  currentTool: string | null = null;
  lastTool: string | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastUsage: TokenUsage | null = null;
  lastMessage: string | null = null;
  conversationTitle: string | null = null;

  /**
   * When true, every query runs with permissionMode: 'plan' — Claude can
   * read/research and produce a plan but cannot execute tools that change
   * state. Toggled by the bot's /plan and /build commands.
   */
  planMode = false;

  /** Toggle plan mode for this session. Returns the new value. */
  setPlanMode(on: boolean): boolean {
    this.planMode = on;
    console.log(`[Session:${this.sessionKey}] Plan mode ${on ? "ON" : "OFF"}`);
    return this.planMode;
  }

  private abortController: AbortController | null = null;
  private isQueryRunning = false;
  private stopRequested = false;
  private _isProcessing = false;
  private _wasInterruptedByNewMessage = false;

  // sessionKey distinguishes concurrent per-thread instances in the session
  // history file (see src/ext/session-manager.ts). "default" preserves the
  // pre-existing single-session behavior exactly. Public so the permission
  // module and /plan,/build can address pending requests for this session.
  constructor(readonly sessionKey: string = "default") {}

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  get isRunning(): boolean {
    return this.isQueryRunning || this._isProcessing;
  }

  /**
   * Check if the last stop was triggered by a new message interrupt (! prefix).
   * Resets the flag when called. Also clears stopRequested so new messages can proceed.
   */
  consumeInterruptFlag(): boolean {
    const was = this._wasInterruptedByNewMessage;
    this._wasInterruptedByNewMessage = false;
    if (was) {
      // Clear stopRequested so the new message can proceed
      this.stopRequested = false;
    }
    return was;
  }

  /**
   * Mark that this stop is from a new message interrupt.
   */
  markInterrupt(): void {
    this._wasInterruptedByNewMessage = true;
  }

  /**
   * Clear the stopRequested flag (used after interrupt to allow new message to proceed).
   */
  clearStopRequested(): void {
    this.stopRequested = false;
  }

  /**
   * Mark processing as started.
   * Returns a cleanup function to call when done.
   */
  startProcessing(): () => void {
    this._isProcessing = true;
    return () => {
      this._isProcessing = false;
    };
  }

  /**
   * Stop the currently running query or mark for cancellation.
   * Returns: "stopped" if query was aborted, "pending" if processing will be cancelled, false if nothing running
   */
  async stop(): Promise<"stopped" | "pending" | false> {
    // If a query is actively running, abort it
    if (this.isQueryRunning && this.abortController) {
      this.stopRequested = true;
      this.abortController.abort();
      console.log("Stop requested - aborting current query");
      return "stopped";
    }

    // If processing but query not started yet
    if (this._isProcessing) {
      this.stopRequested = true;
      console.log("Stop requested - will cancel before query starts");
      return "pending";
    }

    return false;
  }

  /**
   * Send a message to Claude with streaming updates via callback.
   *
   * @param ctx - grammY context for ask_user button display
   */
  async sendMessageStreaming(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context
  ): Promise<string> {
    // Set chat context for ask_user MCP tool
    if (chatId) {
      process.env.TELEGRAM_CHAT_ID = String(chatId);
    }

    // After a service restart the in-memory instance Map is empty, so this
    // instance starts inactive even though the thread has a persisted session.
    // Restore it now so the first message continues the conversation instead
    // of silently starting a brand-new Claude session.
    this.restorePersistedSession();

    const isNewSession = !this.isActive;
    const thinkingTokens = getThinkingLevel(message);
    const thinkingLabel =
      { 0: "off", 10000: "normal", 50000: "deep" }[thinkingTokens] ||
      String(thinkingTokens);

    // Inject current date/time at session start so Claude doesn't need to call a tool for it
    let messageToSend = message;
    if (isNewSession) {
      const now = new Date();
      const datePrefix = `[Current date/time: ${now.toLocaleDateString(
        "en-US",
        {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
        }
      )}]\n\n`;
      messageToSend = datePrefix + message;
    }

    // Build SDK V1 options - supports all features
    // Plan mode uses permissionMode 'plan' (research/plan only, no tool
    // execution). Otherwise "default", so the SDK asks us about every tool
    // that needs approval: canUseTool either auto-allows it (bot allowlist) or
    // asks the user with an inline keyboard. Set PERMISSION_PROMPTS=false to
    // restore the old fully-autonomous bypass behaviour.
    // "default" mode is only safe when canUseTool exists — without the
    // callback the SDK answers every request with its placeholder string and
    // the tool call never settles (the bug that froze plan mode).
    const promptsEnabled = PERMISSION_PROMPTS && !!chatId;

    const permissionMode: Options["permissionMode"] = this.planMode
      ? "plan"
      : promptsEnabled
        ? "default"
        : "bypassPermissions";

    const threadId = ctx?.msg?.message_thread_id;
    const canUseTool: CanUseTool | undefined = promptsEnabled
      ? async (toolName, input, opts) => {
          if (isToolAutoAllowed(toolName, input)) {
            return { behavior: "allow", updatedInput: input };
          }

          const result = await requestPermission({
            sessionKey: this.sessionKey,
            toolName,
            input,
            suggestions: opts.suggestions,
            // The gate shows the user why it is asking: the CLI's own wording,
            // plus the path it rejected when there is one.
            decisionReason: opts.decisionReason,
            blockedPath: opts.blockedPath,
            chatId,
            threadId,
            signal: opts.signal,
          });

          if (toolName === "ExitPlanMode" && result.behavior === "allow") {
            // Keep the bot-side flag in step with the CLI. Without this the
            // next query would pass permissionMode 'plan' again and put the
            // resumed session straight back into plan mode.
            this.planMode = false;
            console.log(
              `[Session:${this.sessionKey}] Plan mode exited by user approval`
            );
          }

          return result;
        }
      : undefined;

    const options: Options = {
      model: "claude-sonnet-4-5",
      cwd: WORKING_DIR,
      settingSources: ["user", "project"],
      permissionMode,
      ...(permissionMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(canUseTool ? { canUseTool } : {}),
      systemPrompt: SAFETY_PROMPT,
      mcpServers: MCP_SERVERS,
      maxThinkingTokens: thinkingTokens,
      additionalDirectories: ALLOWED_PATHS,
      resume: this.sessionId || undefined,
    };

    // Add Claude Code executable path if set (required for standalone builds)
    if (process.env.CLAUDE_CODE_PATH) {
      options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_PATH;
    }

    const modeLabel = this.planMode ? ", plan mode" : "";
    if (this.sessionId && !isNewSession) {
      console.log(
        `[Session:${this.sessionKey}] RESUMING session ${this.sessionId.slice(
          0,
          8
        )}... (thinking=${thinkingLabel}${modeLabel})`
      );
    } else {
      console.log(`[Session:${this.sessionKey}] STARTING new Claude session (thinking=${thinkingLabel}${modeLabel})`);
      this.sessionId = null;
    }

    // Check if stop was requested during processing phase
    if (this.stopRequested) {
      console.log(
        "Query cancelled before starting (stop was requested during processing)"
      );
      this.stopRequested = false;
      throw new Error("Query cancelled");
    }

    // Create abort controller for cancellation
    this.abortController = new AbortController();
    this.isQueryRunning = true;
    this.stopRequested = false;
    this.queryStarted = new Date();
    this.currentTool = null;

    // Response tracking
    const responseParts: string[] = [];
    let currentSegmentId = 0;
    let currentSegmentText = "";
    let lastTextUpdate = 0;
    let queryCompleted = false;
    let askUserTriggered = false;

    try {
      // Use V1 query() API - supports all options including cwd, mcpServers, etc.
      const queryInstance = query({
        prompt: messageToSend,
        options: {
          ...options,
          abortController: this.abortController,
        },
      });

      // Process streaming response
      for await (const event of queryInstance) {
        // Check for abort
        if (this.stopRequested) {
          console.log("Query aborted by user");
          break;
        }

        // Capture session_id from first message
        if (!this.sessionId && event.session_id) {
          this.sessionId = event.session_id;
          console.log(`[Session:${this.sessionKey}] GOT session_id: ${this.sessionId!.slice(0, 8)}...`);
          await this.saveSession();
        }

        // Harvest the Claude Code CLI's slash-commands/skills from the init
        // system message so the Telegram "/" menu can surface them dynamically.
        if (event.type === "system" && event.subtype === "init") {
          const slash = event.slash_commands ?? [];
          const skills = event.skills ?? [];
          if (slash.length || skills.length) {
            console.log(
              `[Session:${this.sessionKey}] Claude commands: ${slash.length} slash, ${skills.length} skills`
            );
            updateClaudeCommands(slash, skills);
          }
        }

        // Handle different message types
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            // Thinking blocks
            if (block.type === "thinking") {
              const thinkingText = block.thinking;
              if (thinkingText) {
                console.log(`THINKING BLOCK: ${thinkingText.slice(0, 100)}...`);
                await statusCallback("thinking", thinkingText);
              }
            }

            // Tool use blocks
            if (block.type === "tool_use") {
              const toolName = block.name;
              const toolInput = block.input as Record<string, unknown>;

              // Post-hoc safety net. Only active when canUseTool is absent
              // (PERMISSION_PROMPTS=false): with prompts on, the pre-flight
              // callback already auto-allowed or asked the user, so throwing
              // here would override an explicit "Allow" tap.
              if (!canUseTool) {
                // Safety check for Bash commands
                if (toolName === "Bash") {
                  const command = String(toolInput.command || "");
                  const [isSafe, reason] = checkCommandSafety(command);
                  if (!isSafe) {
                    console.warn(`BLOCKED: ${reason}`);
                    await statusCallback("tool", `BLOCKED: ${reason}`);
                    throw new Error(`Unsafe command blocked: ${reason}`);
                  }
                }

                // Safety check for file operations
                if (["Read", "Write", "Edit"].includes(toolName)) {
                  const filePath = String(toolInput.file_path || "");
                  if (filePath) {
                    // Allow reads from temp paths and .claude directories
                    const isTmpRead =
                      toolName === "Read" &&
                      (TEMP_PATHS.some((p) => filePath.startsWith(p)) ||
                        filePath.includes("/.claude/"));

                    if (!isTmpRead && !isPathAllowed(filePath)) {
                      console.warn(
                        `BLOCKED: File access outside allowed paths: ${filePath}`
                      );
                      await statusCallback("tool", `Access denied: ${filePath}`);
                      throw new Error(`File access blocked: ${filePath}`);
                    }
                  }
                }
              }

              // Segment ends when tool starts
              if (currentSegmentText) {
                await statusCallback(
                  "segment_end",
                  currentSegmentText,
                  currentSegmentId
                );
                currentSegmentId++;
                currentSegmentText = "";
              }

              // Format and show tool status
              const toolDisplay = formatToolStatus(toolName, toolInput);
              this.currentTool = toolDisplay;
              this.lastTool = toolDisplay;
              console.log(`Tool: ${toolDisplay}`);

              // Don't show tool status for ask_user/send_file - they handle their own UI
              if (
                !toolName.startsWith("mcp__ask-user") &&
                !toolName.startsWith("mcp__send-file")
              ) {
                await statusCallback("tool", toolDisplay);
              }

              // Check for pending ask_user requests after ask-user MCP tool
              if (toolName.startsWith("mcp__ask-user") && ctx && chatId) {
                // Small delay to let MCP server write the file
                await new Promise((resolve) => setTimeout(resolve, 200));

                // Retry a few times in case of timing issues
                for (let attempt = 0; attempt < 3; attempt++) {
                  const buttonsSent = await checkPendingAskUserRequests(
                    ctx,
                    chatId
                  );
                  if (buttonsSent) {
                    askUserTriggered = true;
                    break;
                  }
                  if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
              }

              // Send file to user after send-file MCP tool (fire-and-forget)
              if (toolName.startsWith("mcp__send-file") && ctx && chatId) {
                await new Promise((resolve) => setTimeout(resolve, 200));
                for (let attempt = 0; attempt < 3; attempt++) {
                  const sent = await checkPendingSendFileRequests(ctx, chatId);
                  if (sent) break;
                  if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
                // NO break — Claude continues generating
              }
            }

            // Text content
            if (block.type === "text") {
              responseParts.push(block.text);
              currentSegmentText += block.text;

              // Stream text updates (throttled)
              const now = Date.now();
              if (
                now - lastTextUpdate > STREAMING_THROTTLE_MS &&
                currentSegmentText.length > 20
              ) {
                await statusCallback(
                  "text",
                  currentSegmentText,
                  currentSegmentId
                );
                lastTextUpdate = now;
              }
            }
          }

          // Break out of event loop if ask_user was triggered
          if (askUserTriggered) {
            break;
          }
        }

        // Result message
        if (event.type === "result") {
          console.log("Response complete");
          queryCompleted = true;

          // Capture usage if available
          if ("usage" in event && event.usage) {
            this.lastUsage = event.usage as TokenUsage;
            const u = this.lastUsage;
            console.log(
              `Usage: in=${u.input_tokens} out=${u.output_tokens} cache_read=${
                u.cache_read_input_tokens || 0
              } cache_create=${u.cache_creation_input_tokens || 0}`
            );
          }
        }
      }

      // V1 query completes automatically when the generator ends
    } catch (error) {
      const errorStr = String(error).toLowerCase();
      const isCleanupError =
        errorStr.includes("cancel") || errorStr.includes("abort");

      if (
        isCleanupError &&
        (queryCompleted || askUserTriggered || this.stopRequested)
      ) {
        console.warn(`Suppressed post-completion error: ${error}`);
      } else {
        console.error(`[Session:${this.sessionKey}] Error in query: ${error}`);
        this.lastError = String(error).slice(0, 100);
        this.lastErrorTime = new Date();
        throw error;
      }
    } finally {
      this.isQueryRunning = false;
      this.abortController = null;
      this.queryStarted = null;
      this.currentTool = null;
    }

    this.lastActivity = new Date();
    this.lastError = null;
    this.lastErrorTime = null;

    // If ask_user was triggered, return early - user will respond via button
    if (askUserTriggered) {
      await statusCallback("done", "");
      return "[Waiting for user selection]";
    }

    // Emit final segment
    if (currentSegmentText) {
      await statusCallback("segment_end", currentSegmentText, currentSegmentId);
    }

    await statusCallback("done", "");

    return responseParts.join("") || "No response from Claude.";
  }

  /**
   * Kill the current session (clear session_id).
   */
  async kill(): Promise<void> {
    const wasActive = this.sessionId !== null;
    const oldSessionId = this.sessionId?.slice(0, 8);
    this.sessionId = null;
    this.lastActivity = null;
    this.conversationTitle = null;
    this.planMode = false;
    // Clear the persisted binding so a later restart does not resurrect a
    // session the user explicitly ended with /new.
    setMappedSessionId(this.sessionKey, null);
    console.log(`[Session:${this.sessionKey}] KILLED session${wasActive ? ` (was: ${oldSessionId}...)` : ' (was already inactive)'}`);
  }

  /**
   * Save session to disk for resume after restart.
   * Saves to multi-session history format.
   */
  async saveSession(): Promise<void> {
    if (!this.sessionId) return;

    try {
      // Load existing session history
      const history = this.loadSessionHistory();

      // Create new session entry
      const newSession: SavedSession = {
        session_id: this.sessionId,
        saved_at: new Date().toISOString(),
        working_dir: WORKING_DIR,
        title: this.conversationTitle || "Sessione senza titolo",
        session_key: this.sessionKey,
      };

      // Remove any existing entry with same session_id (update in place)
      const existingIndex = history.sessions.findIndex(
        (s) => s.session_id === this.sessionId
      );
      if (existingIndex !== -1) {
        history.sessions[existingIndex] = newSession;
      } else {
        // Add new session at the beginning
        history.sessions.unshift(newSession);
      }

      // Keep only the last MAX_SESSIONS
      history.sessions = history.sessions.slice(0, MAX_SESSIONS);

      // Persist history first, then bind the thread key to this session id so
      // the mapping never points at a session that isn't on disk yet.
      await Bun.write(historyFilePath(), JSON.stringify(history, null, 2));
      setMappedSessionId(this.sessionKey, this.sessionId);
      console.log(`[Session:${this.sessionKey}] Session saved to ${historyFilePath()}`);
    } catch (error) {
      console.warn(`[Session:${this.sessionKey}] Failed to save session: ${error}`);
    }
  }

  /**
   * Load session history from disk.
   */
  private loadSessionHistory(): SessionHistory {
    try {
      const file = Bun.file(historyFilePath());
      if (!file.size) {
        return { sessions: [] };
      }

      const text = readFileSync(historyFilePath(), "utf-8");
      return JSON.parse(text) as SessionHistory;
    } catch {
      return { sessions: [] };
    }
  }

  /**
   * Get list of saved sessions for display.
   */
  getSessionList(): SavedSession[] {
    const history = this.loadSessionHistory();
    // Filter to only sessions for current working directory and this thread's key
    return history.sessions.filter(
      (s) =>
        (!s.working_dir || s.working_dir === WORKING_DIR) &&
        (s.session_key ?? "default") === this.sessionKey
    );
  }

  /**
   * Resume a specific session by ID.
   */
  resumeSession(sessionId: string): [success: boolean, message: string] {
    const history = this.loadSessionHistory();
    const sessionData = history.sessions.find((s) => s.session_id === sessionId);

    if (!sessionData) {
      console.log(`[Session:${this.sessionKey}] RESUME FAILED - session not found: ${sessionId.slice(0, 8)}...`);
      return [false, "Sessione non trovata"];
    }

    if (sessionData.working_dir && sessionData.working_dir !== WORKING_DIR) {
      console.log(`[Session:${this.sessionKey}] RESUME FAILED - wrong dir: ${sessionData.working_dir}`);
      return [
        false,
        `Sessione per directory diversa: ${sessionData.working_dir}`,
      ];
    }

    this.sessionId = sessionData.session_id;
    this.conversationTitle = sessionData.title;
    this.lastActivity = new Date();
    // Bind the thread key to the resumed session so it survives a restart.
    setMappedSessionId(this.sessionKey, sessionData.session_id);

    console.log(
      `[Session:${this.sessionKey}] RESUMED session ${sessionData.session_id.slice(0, 8)}... - "${sessionData.title}"`
    );

    return [
      true,
      `Ripresa sessione: "${sessionData.title}"`,
    ];
  }

  /**
   * Resume the last persisted session (legacy method, now resumes most recent).
   */
  resumeLast(): [success: boolean, message: string] {
    const sessions = this.getSessionList();
    if (sessions.length === 0) {
      return [false, "Nessuna sessione salvata"];
    }

    return this.resumeSession(sessions[0]!.session_id);
  }

  /**
   * Restore the persisted session bound to this thread key, if any.
   *
   * The binding is written by saveSession()/resumeSession() and cleared by
   * kill() (see src/ext/session-map.ts). Because it lives on disk, it survives
   * a service restart even though the in-memory instance Map does not.
   *
   * Returns true when a session was restored. A stale binding (session no
   * longer in the history file) is cleared so the next message starts fresh
   * instead of looping on a bad resume.
   */
  restorePersistedSession(): boolean {
    if (this.sessionId) return false;

    const mapped = getMappedSessionId(this.sessionKey);
    if (!mapped) return false;

    const [ok] = this.resumeSession(mapped);
    if (!ok) {
      console.warn(
        `[Session:${this.sessionKey}] Persisted session ${mapped.slice(
          0,
          8
        )}... no longer available, clearing mapping`
      );
      setMappedSessionId(this.sessionKey, null);
      return false;
    }

    console.log(
      `[Session:${this.sessionKey}] Auto-restored persisted session ${mapped.slice(
        0,
        8
      )}... after restart`
    );
    return true;
  }
}

// Global session instance
export const session = new ClaudeSession();
