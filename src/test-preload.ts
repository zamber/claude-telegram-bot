/**
 * Test-only environment pinning.
 *
 * src/config.ts reads process.env at import time, so these values must be set
 * before any test file imports it. The `??=` form keeps a real value when one
 * is present (Bun loads the gitignored .env, so the live bot's allowlist wins
 * on this host), and falls back to a synthetic one everywhere else - tests
 * must not depend on a file that is not in the repository.
 */

process.env.TELEGRAM_ALLOWED_USERS ??= "424242";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
