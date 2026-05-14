/**
 * Utilities for handling environment variables securely.
 * Provides redaction and logging for sensitive env vars.
 */

/**
 * Redact sensitive env var values for logging.
 * Shows full value for known non-sensitive config, redacts everything else.
 *
 * Non-sensitive: BASE_URL, TIMEOUT, DEBUG, LOG_LEVEL, MODEL, MAX_TOKENS, etc.
 * Sensitive: TOKEN, KEY, SECRET, PASSWORD, AUTH, CUSTOM, HEADERS, CREDENTIAL, etc.
 */
export function redactEnvValue(key: string, value: string): string {
  // Known non-sensitive config vars (show in full even if they contain "key" words)
  const nonSensitivePatterns = [
    /BASE_?URL$/i,
    /ENDPOINT$/i,
    /TIMEOUT$/i,
    /DEBUG$/i,
    /LOG_?LEVEL$/i,
    /MODEL$/i,
    /MAX_?TOKENS$/i,
    /TEMPERATURE$/i,
    /TOP_?[PK]$/i,
  ];

  // If it's a known non-sensitive config var, show in full
  if (nonSensitivePatterns.some((pattern) => pattern.test(key))) {
    return value;
  }

  // Patterns that indicate sensitive data (redact these for ANY var)
  const sensitivePatterns = [
    /TOKEN/i,
    /KEY/i,
    /SECRET/i,
    /PASSWORD/i,
    /AUTH/i,
    /CREDENTIAL/i,
    /CUSTOM/i,
    /HEADER/i,
    /BEARER/i,
    /OAUTH/i,
  ];

  // Redact if matches any sensitive pattern (applies to all vars, not just ANTHROPIC_/CLAUDE_*)
  if (sensitivePatterns.some((pattern) => pattern.test(key))) {
    if (value.length <= 8) return "***";
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  // Default: show in full for non-sensitive vars
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
