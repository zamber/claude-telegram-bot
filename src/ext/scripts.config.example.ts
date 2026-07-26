/**
 * Whitelisted ~/.bin scripts runnable from Telegram via /run <name> [args...].
 *
 * Copy this file to scripts.config.ts (gitignored, like mcp-config.ts) and
 * edit it in place. The allowlist is opt-in on purpose: nothing here by
 * default. Only add a script once you've re-read it and are sure its output
 * is safe to relay back into a Telegram chat.
 *
 * DO NOT add these, found unsafe for remote invocation during the original
 * audit of ~/.bin (see ~/projects/infra-notes for the full writeup):
 *   - ,bw_unlock.sh      — its entire purpose is printing a live Bitwarden
 *                          session token to stdout, which /run would relay
 *                          straight into the Telegram chat.
 *   - ,frameo_adb.sh     — passes arbitrary trailing args to `sudo adb`;
 *                          unrestricted remote command execution.
 *   - ,mail.sh           — hardcoded Gmail app password in the script body;
 *                          if you do want remote email, wrap it so the
 *                          allowed args can't turn it into an open relay.
 *   - ,maly.sh / ,maly_speak.sh — hardcoded Home Assistant long-lived token.
 *   - ,new_thread_luna.sh, ,notify_maly_tts.sh, ,monitor_fridge_power.sh —
 *                          dead/retired, call things that no longer exist.
 */

import type { ScriptDef } from "./scripts";
import { homedir } from "os";

const HOME = homedir();

export const SCRIPTS: ScriptDef[] = [
  {
    name: "transcribe",
    path: `${HOME}/.bin/,transcribe.sh`,
    description: "Transcribe an audio/video file to Polish text (local Whisper)",
    args: ["file", "outputDir?"],
    acceptsFile: true,
    timeoutMs: 120_000,
  },
  {
    name: "print",
    path: `${HOME}/.bin/,print.sh`,
    description: "Print a file on the Brother printer via CUPS",
    args: ["file"],
    acceptsFile: true,
  },
  {
    name: "hue-red",
    path: `${HOME}/.bin/,turn_hue_lights_red.sh`,
    description: "Set the living room Hue lights to red",
  },
  {
    name: "frameo-nav",
    path: `${HOME}/.bin/,frameo_nav.sh`,
    description: "Send a canned navigation action to the Frameo photo frame",
    args: ["back|home|recent|apps|frameo|kiss|fdroid|bromite|ha"],
  },
];
