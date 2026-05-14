/**
 * Utilities for handling environment variables securely.
 * Provides redaction and logging for sensitive env vars.
 */

/**
 * Redact sensitive env var values for logging.
 * Shows first 4 and last 4 characters for secrets, full value otherwise.
 */
export function redactEnvValue(key: string, value: string): string {
  const secretPatterns = [
    /token/i,
    /key/i,
    /secret/i,
    /password/i,
    /auth/i,
    /credential/i,
  ];

  if (secretPatterns.some((pattern) => pattern.test(key))) {
    if (value.length <= 8) return "***";
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }
  return value;
}

/**
 * Log environment variables with automatic redaction of secrets.
 * @param vars - Array of env var names to log
 * @param env - Environment object containing the values
 * @param prefix - Optional prefix for log messages
 */
export function logEnvVars(
  vars: string[],
  env: Record<string, string>,
  prefix = "[deepsec]",
): void {
  if (vars.length === 0) return;

  console.error(`${prefix} Forwarding env vars to agent:`);
  for (const k of vars.sort()) {
    const value = env[k];
    if (value === undefined) continue;
    const redacted = redactEnvValue(k, value);
    console.error(`  ${k}=${redacted}`);
  }
}

/**
 * Filter env vars by prefix and build a new env object.
 * @param prefixes - Array of prefixes to match (e.g., ["ANTHROPIC_", "CLAUDE_"])
 * @param sourceEnv - Source environment (defaults to process.env)
 * @returns Object with filtered env vars and list of matched keys
 */
export function filterEnvByPrefix(
  prefixes: string[],
  sourceEnv: Record<string, string | undefined> = process.env,
): { env: Record<string, string>; keys: string[] } {
  const env: Record<string, string> = {};
  const keys: string[] = [];

  for (const [k, v] of Object.entries(sourceEnv)) {
    if (typeof v !== "string") continue;
    if (prefixes.some((prefix) => k.startsWith(prefix))) {
      env[k] = v;
      keys.push(k);
    }
  }

  return { env, keys };
}
