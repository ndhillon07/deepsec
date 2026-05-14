/**
 * Retry helper for handling JSON parse failures in agent responses.
 * Provides automatic retry logic with stricter prompts when Claude returns
 * verbose explanations before JSON output.
 */

import type { ProcessorConfig } from "./types.js";

export interface RetryOptions {
  /** Original config to append retry instructions to */
  config: ProcessorConfig;
  /** Whether quota has been exhausted */
  quotaAborted: boolean;
  /** Error message pattern to match for retry (e.g., "parseable JSON") */
  errorPattern: string;
}

/**
 * Checks if an error qualifies for retry (JSON parse failure, quota not exhausted)
 */
export function shouldRetry(err: unknown, options: RetryOptions): boolean {
  const isJsonError = err instanceof Error && err.message.includes(options.errorPattern);
  return isJsonError && !options.quotaAborted;
}

/**
 * Creates a retry config with stricter JSON-only instructions appended.
 * This is used when the LLM returns explanatory text before JSON.
 */
export function createRetryConfig(config: ProcessorConfig): ProcessorConfig {
  return {
    ...config,
    systemPromptAppend: `${config.systemPromptAppend || ""}\n\nREMINDER: Your previous response was not valid JSON. Return ONLY the JSON array with no explanatory text before or after. Start with [ and end with ]. Nothing else.`,
  };
}
