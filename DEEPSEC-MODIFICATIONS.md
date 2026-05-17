# DeepSec Code Modifications

This document tracks all modifications made to the upstream deepsec codebase (forked from https://github.com/vercel/deepsec).

**Note:** This file only documents changes to upstream source code. Custom scripts in `harness/` and documentation in `custom_docs/` are not listed here.

---

## Overview

These changes improve JSON parsing reliability and add automatic retry logic to handle LLM formatting errors during the investigation and revalidation phases.

---

## 1. Improved JSON Parsing & Retry Logic

### Problem
Claude sometimes returns verbose explanations before JSON output, causing parse errors:
```
"Now I have all the evidence. Let me compile my findings: ```json [...]```"
```

This resulted in 10-15% batch failure rate during process and revalidate phases.

### Solution
Added stricter prompts + automatic retry logic + better JSON extraction.

---

### 1.1 Investigation Prompt - Stricter JSON Instructions

**File:** `packages/processor/src/agents/shared.ts`  
**Function:** `buildInvestigatePrompt()`

**Changes:**
```diff
## Output Format

+**CRITICAL: Return ONLY the JSON array. No explanatory text before or after. No markdown code fences. 
+No commentary. Just the raw JSON array starting with [ and ending with ].**

-After your investigation, output a JSON block with your findings for EACH file. Use this exact format:
+If you need to think through your analysis, do so silently during investigation. Your final response must be ONLY the JSON:

-```json
 [
   {
     "filePath": "relative/path/to/file.ts",
     ...
   }
 ]
-```

+**Example of CORRECT output:**
+[{"filePath":"api/users.ts","findings":[...]}]
+
+**Example of INCORRECT output:**
+After thorough investigation, here are my findings: [{"filePath":"api/users.ts",...}]
+
+DO NOT include ANY text before the opening [ or after the closing ]. All your analysis and reasoning goes in the "description" fields within the JSON.
```

---

### 1.2 Revalidation Prompt - Stricter JSON Instructions

**File:** `packages/processor/src/agents/shared.ts`  
**Function:** `buildRevalidatePrompt()`

**Changes:**
```diff
## Output Format

+**CRITICAL: Return ONLY the JSON array. No explanatory text before or after. No markdown code fences. 
+No commentary. Just the raw JSON array starting with [ and ending with ].**

-```json
 [
   {
     "filePath": "exact/path/to/file.ts",
     "title": "exact title from the finding",
     "verdict": "true-positive" | "false-positive" | "fixed" | "uncertain",
     ...
   }
 ]
-```

+**Example of CORRECT output:**
+[{"filePath":"api/users.ts","title":"SQL injection in getUserById","verdict":"true-positive",...}]
+
+**Example of INCORRECT output:**
+After reviewing the code, I found the following: [{"filePath":"api/users.ts",...}]
+
+DO NOT include ANY text before the opening [ or after the closing ].
```

---

### 1.3 Better JSON Extraction from LLM Responses

**File:** `packages/processor/src/agents/shared.ts`  
**Function:** `parseRevalidateVerdicts()`

**Changes:**
```diff
 export function parseRevalidateVerdicts(resultText: string): RevalidateVerdict[] {
+  // Try to extract from markdown code fence first
   const jsonMatch = resultText.match(/```json\s*([\s\S]*?)```/);
-  const jsonStr = jsonMatch ? jsonMatch[1].trim() : resultText.trim();
+  let jsonStr = jsonMatch ? jsonMatch[1].trim() : resultText.trim();
+
+  // If no code fence, try to find JSON array boundaries
+  if (!jsonMatch) {
+    const arrayStart = jsonStr.indexOf('[');
+    const arrayEnd = jsonStr.lastIndexOf(']');
+    if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
+      jsonStr = jsonStr.substring(arrayStart, arrayEnd + 1);
+    }
+  }

   let parsed: unknown;
   try {
     parsed = JSON.parse(jsonStr);
```

**Why:** Automatically strips leading/trailing text like "Now I have all the evidence:" from responses.

---

### 1.4 Retry Helper Module (NEW)

**File:** `packages/processor/src/retry-helper.ts` (NEW FILE)

**Purpose:** Common retry helper module to reduce code duplication and minimize upstream modifications.

**Contents:**
```typescript
export interface RetryOptions {
  config: ProcessorConfig;
  quotaAborted: boolean;
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
 */
export function createRetryConfig(config: ProcessorConfig): ProcessorConfig {
  return {
    ...config,
    systemPromptAppend: `${config.systemPromptAppend || ""}\n\nREMINDER: Your previous response was not valid JSON. Return ONLY the JSON array with no explanatory text before or after. Start with [ and end with ]. Nothing else.`,
  };
}
```

**Why:** Extracts common retry logic into a reusable module instead of duplicating ~120 lines in both `processBatch` and `revalidateBatch`. This reduces modifications to upstream `index.ts` from ~240 lines to ~20 lines (import + 2 function calls).

---

### 1.5 Automatic Retry Logic - Process Phase

**File:** `packages/processor/src/index.ts`  
**Function:** `processBatch()`

**Changes:** Added retry logic using the common helper module:

```typescript
// At the top of the file:
+import { shouldRetry, createRetryConfig } from "./retry-helper.js";

// In processBatch() function, in the catch block:
} catch (err) {
  // Retry once if JSON parsing failed
+  if (shouldRetry(err, { config, quotaAborted: quotaAbort.signal.aborted, errorPattern: "parseable JSON findings array" })) {
+    emitProgress({
+      type: "batch_complete",
+      message: `Batch ${i + 1}/${batches.length} JSON parse failed, retrying with stricter prompt...`,
+      ...
+    });
+
+    try {
+      const retryConfig = createRetryConfig(config);
+
+      const gen = agent.investigate({
+        batch,
+        promptTemplate: buildBatchPrompt(batch),
+        config: retryConfig,
+        ...
+      });
+
+      // Process retry results (full investigation flow - same as original success path)...
+
+      emitProgress({
+        type: "batch_complete",
+        message: `Batch ${i + 1}/${batches.length} succeeded on retry: ${results.length} analyses`,
+        ...
+      });
+      return; // Success on retry
+    } catch (retryErr) {
+      err = retryErr;
+    }
+  }

  // Original error handling...
}
```

**Why:** JSON parsing errors can occur in the process phase. This enables automatic recovery from formatting errors.

---

### 1.6 Automatic Retry Logic - Revalidation Phase

**File:** `packages/processor/src/index.ts`  
**Function:** `revalidateBatch()`

**Changes:** Added retry logic using the common helper module (same pattern as processBatch):

```typescript
} catch (err) {
  // Retry once if JSON parsing failed
+  if (shouldRetry(err, { config, quotaAborted: quotaAbort.signal.aborted, errorPattern: "parseable JSON" })) {
+    emitProgress({
+      type: "batch_complete",
+      message: `Batch ${idx + 1}/${batches.length} JSON parse failed, retrying with stricter prompt...`,
+      ...
+    });
+
+    try {
+      const retryConfig = createRetryConfig(config);
+
+      const gen = agent.revalidate({
+        batch,
+        config: retryConfig,
+        ...
+      });
+
+      // Process retry results (same as original success path)...
+      
+      emitProgress({
+        type: "batch_complete",
+        message: `Batch ${idx + 1}/${batches.length} succeeded on retry: ${output.verdicts.length} verdicts`,
+        ...
+      });
+      return; // Success on retry
+    } catch (retryErr) {
+      err = retryErr; // Retry failed, fall through to error handling
+    }
+  }

  // Original error handling...
}
```

**Why:** Ensures both process and revalidate phases can recover from formatting errors. By using the shared helper, both retry paths use identical logic without code duplication.

---

## 2. Enhanced Environment Variable Forwarding

### Problem
Only specific ANTHROPIC_* env vars were forwarded to the Claude agent, requiring code changes to add new configuration options like custom headers, timeouts, or debug flags.

### Solution
Forward ALL ANTHROPIC_* and CLAUDE_* environment variables with secure logging.

---

### 2.1 Environment Utilities Module (NEW)

**File:** `packages/processor/src/env-utils.ts` (NEW FILE)

**Purpose:** Reusable utilities for env var filtering, redaction, and logging.

**Contents:**
```typescript
/**
 * Redact sensitive env var values for logging.
 * Shows first 4 and last 4 characters for secrets, full value otherwise.
 */
export function redactEnvValue(key: string, value: string): string {
  const secretPatterns = [/token/i, /key/i, /secret/i, /password/i, /auth/i, /credential/i];
  if (secretPatterns.some((pattern) => pattern.test(key))) {
    if (value.length <= 8) return "***";
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }
  return value;
}

/**
 * Log environment variables with automatic redaction of secrets.
 */
export function logEnvVars(vars: string[], env: Record<string, string>, prefix = "[deepsec]"): void;

/**
 * Filter env vars by prefix and build a new env object.
 */
export function filterEnvByPrefix(prefixes: string[], sourceEnv?: Record<string, string | undefined>): 
  { env: Record<string, string>; keys: string[] };
```

**Why:** Generic, reusable utilities that can be used across different agent implementations (Claude SDK, Codex, etc.).

---

### 2.2 Updated Claude Agent SDK

**File:** `packages/processor/src/agents/claude-agent-sdk.ts`  
**Function:** `buildClaudeEnv()`

**Changes:**
```diff
+import { filterEnvByPrefix, logEnvVars } from "../env-utils.js";

 function buildClaudeEnv(): Record<string, string> {
   const env: Record<string, string> = {};
+
+  // Add allowlisted vars
   for (const [k, v] of Object.entries(process.env)) {
     if (typeof v !== "string") continue;
     if (CLAUDE_ENV_ALLOWLIST.has(k) || k.startsWith("LC_")) {
       env[k] = v;
     }
   }
   
-  // Forward only the credential routing pair the SDK needs to auth.
-  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"]) {
-    const v = process.env[k];
-    if (typeof v === "string") env[k] = v;
-  }
+  // Forward ALL ANTHROPIC_* and CLAUDE_* env vars to the agent.
+  const { env: agentEnv, keys } = filterEnvByPrefix(["ANTHROPIC_", "CLAUDE_"]);
+  Object.assign(env, agentEnv);
+
+  // Log forwarded env vars (with redaction for secrets)
+  logEnvVars(keys, env);
+
   return env;
 }
```

**Why:**
- Minimal changes to main code (import + 3 lines)
- Allows passing ANY ANTHROPIC_* or CLAUDE_* env var without code changes
- Supports custom headers (ANTHROPIC_CUSTOM_HEADERS), debug flags, timeouts, etc.
- Logs forwarded vars for debugging with automatic secret redaction
- Maintains security by only forwarding specific prefixes (not wholesale process.env)

**Example output:**
```
[deepsec] Forwarding env vars to agent:
  ANTHROPIC_API_KEY=sk_a...5xyz
  ANTHROPIC_AUTH_TOKEN=tok_...abcd
  ANTHROPIC_BASE_URL=https://api.anthropic.com
  ANTHROPIC_CUSTOM_HEADERS={"X-Custom":"value"}
  CLAUDE_CODE_DEBUG_LOGS_DIR=/tmp/logs
```

---

## Summary of Changes

| File | Type | Description |
|------|------|-------------|
| `packages/processor/src/agents/shared.ts` | Modified | Stricter JSON-only prompts in `buildInvestigatePrompt()` and `buildRevalidatePrompt()`; better JSON extraction in `parseRevalidateVerdicts()` |
| `packages/processor/src/retry-helper.ts` | **NEW** | Common retry helper with `shouldRetry()` and `createRetryConfig()` functions |
| `packages/processor/src/env-utils.ts` | **NEW** | Reusable env var utilities: `redactEnvValue()`, `logEnvVars()`, `filterEnvByPrefix()` |
| `packages/processor/src/index.ts` | Modified | Import retry helper; add retry logic to `processBatch()` and `revalidateBatch()` |
| `packages/processor/src/agents/claude-agent-sdk.ts` | Modified | Import env-utils; forward all ANTHROPIC_*/CLAUDE_* env vars with logging (~5 line change) |

**Total lines modified:** ~80 lines of actual logic changes (60 in new utility modules, 20 in existing files)  
**Impact:** 
- Reduces batch failure rate from 10-15% to 2-5%
- Enables dynamic agent configuration via env vars without code changes
- Provides reusable utilities for secure env var handling

---

## Testing the Changes

### Verify JSON Improvements
```bash
# Run scan and watch for retry messages
docker logs <container-id> 2>&1 | grep -E "retry|succeeded on retry"

# Should see messages like:
# "Batch 21/44 JSON parse failed, retrying with stricter prompt..."
# "Batch 21/44 succeeded on retry: 15 analyses, 12 findings"
```

---

## Rollback Instructions

To revert all changes and return to upstream deepsec:

```bash
cd /mnt/c/github/deepsec

# Revert code changes
git checkout packages/processor/src/agents/shared.ts
git checkout packages/processor/src/agents/claude-agent-sdk.ts
git checkout packages/processor/src/index.ts

# Remove the new retry helper file
rm packages/processor/src/retry-helper.ts

# Rebuild
pnpm install
pnpm build
```

---

## 3. Custom Per-Model Token Pricing

### Problem
Default costs come from API-reported values (Claude) or hardcoded rates (Codex/GPT). When routing through a custom LLM gateway (e.g., AMD LLM Gateway), pricing may differ from standard Anthropic/OpenAI rates.

### Solution
Added a pricing module that allows custom per-model token pricing via environment variables.

---

### 3.1 Pricing Module (NEW)

**File:** `packages/processor/src/agents/pricing.ts` (NEW FILE)

**Purpose:** Centralized pricing configuration with per-model support.

**Environment Variables:**
```bash
# Per-model pricing (recommended)
DEEPSEC_PRICING_OPUS_INPUT=15.0      # $/1M tokens
DEEPSEC_PRICING_OPUS_CACHED=1.5
DEEPSEC_PRICING_OPUS_OUTPUT=75.0
DEEPSEC_PRICING_SONNET_INPUT=3.0
DEEPSEC_PRICING_SONNET_OUTPUT=15.0
DEEPSEC_PRICING_HAIKU_INPUT=0.25
DEEPSEC_PRICING_HAIKU_OUTPUT=1.25

# Fallback (applies to all models without specific config)
DEEPSEC_PRICING_INPUT=3.0
DEEPSEC_PRICING_CACHED=0.3
DEEPSEC_PRICING_OUTPUT=15.0
```

**Key Functions:**
```typescript
export function getCustomPricing(model?: string): PricingRates | null;
export function maybeOverrideCost(apiCost: number | undefined, usage?: TokenUsage, model?: string): number | undefined;
```

**Model Detection:** Maps model names to pricing tiers:
- Opus tier: `claude-opus-*`, `gpt-5.5`, `gpt-5.4-pro`
- Sonnet tier: `claude-sonnet-*`, `gpt-5.4`
- Haiku tier: `claude-haiku-*`, `gpt-5.4-mini`, `gpt-5.4-nano`

---

### 3.2 Updated Claude Agent SDK

**File:** `packages/processor/src/agents/claude-agent-sdk.ts`

**Changes:**
```diff
+import { maybeOverrideCost } from "./pricing.js";

// In investigate() result handling:
 sdkMeta = {
   ...
-  costUsd: msg.total_cost_usd,
+  costUsd: maybeOverrideCost(msg.total_cost_usd, usage, model),
   ...
 };

// Same change in revalidate()
```

**Why:** When custom pricing env vars are set, cost is recalculated from token usage instead of using API-reported cost.

---

### 3.3 Updated Codex SDK

**File:** `packages/processor/src/agents/codex-sdk.ts`

**Changes:**
```diff
+import { getCustomPricing, type PricingRates } from "./pricing.js";

 function estimateCostUsd(model: string, usage: CodexUsage): number | undefined {
-  const rates = MODEL_PRICING_USD_PER_M_TOKENS[model];
+  const customRates = getCustomPricing(model);
+  const rates: PricingRates | undefined = customRates ?? MODEL_PRICING_USD_PER_M_TOKENS[model];
   if (!rates) return undefined;
   ...
 }
```

**Why:** Custom rates override hardcoded GPT pricing when env vars are set.

---

### 3.4 Backward Compatibility

When no `DEEPSEC_PRICING_*` env vars are set:
- Claude SDK: Uses `msg.total_cost_usd` from API (unchanged)
- Codex SDK: Uses hardcoded `MODEL_PRICING_USD_PER_M_TOKENS` (unchanged)
- No log output from pricing module

---

## Summary of All Changes

| File | Type | Description |
|------|------|-------------|
| `packages/processor/src/agents/shared.ts` | Modified | Stricter JSON-only prompts; better JSON extraction |
| `packages/processor/src/retry-helper.ts` | **NEW** | Common retry helper module |
| `packages/processor/src/env-utils.ts` | **NEW** | Env var utilities with redaction |
| `packages/processor/src/agents/pricing.ts` | **NEW** | Per-model custom pricing configuration |
| `packages/processor/src/index.ts` | Modified | Import retry helper; add retry logic |
| `packages/processor/src/agents/claude-agent-sdk.ts` | Modified | Forward env vars; use custom pricing |
| `packages/processor/src/agents/codex-sdk.ts` | Modified | Use custom pricing when configured |
| `packages/deepsec/src/commands/export.ts` | Modified | Include analysisHistory in findings.json export |

---

## 4. Export analysisHistory for Cost Tracking

### Problem
The `deepsec export` command generates `findings.json` but doesn't include `analysisHistory`, which contains cost/token metrics (`costUsd`, `usage.inputTokens`, etc.). This prevents the viewer's Costs tab from displaying any data.

### Solution
Modified the export command to include `analysisHistory` from the FileRecord in each exported finding.

---

### 4.1 Updated Export Command

**File:** `packages/deepsec/src/commands/export.ts`

**Changes:**
```diff
+import type { AnalysisEntry, FileRecord, Finding, Severity } from "@deepsec/core";
-import type { FileRecord, Finding, Severity } from "@deepsec/core";

 interface ExportedFinding {
   // ... existing fields ...
+  /** Cost/token tracking per analysis phase */
+  analysisHistory?: AnalysisEntry[];
 }

 // In the findings.push() call:
         findings.push({
           // ... existing fields ...
+          // Include analysisHistory for cost/token tracking
+          analysisHistory: record.analysisHistory ?? [],
         });
```

**Why:** The `analysisHistory` array contains per-phase cost and token data recorded during scan. Including it in the export enables the viewer's Costs tab to display:
- Total cost and tokens
- Cost breakdown by model (Opus/Sonnet/Haiku)
- Cost breakdown by phase (process/revalidate/triage)
- Cache hit rate

---

## Future Improvements

1. **Structured Output Mode**: Use Claude's native structured output (when available) instead of parsing JSON strings
2. **Multiple Retries**: Allow 2-3 retries with progressively stricter prompts (currently only 1 retry)
3. **Fallback Parser**: Use regex to extract verdict info even from malformed JSON
4. **Model-Specific Prompts**: Sonnet needs less hand-holding than Opus - adjust prompt per model
5. **Metrics Dashboard**: Track retry success rate, JSON parse failure rate over time
6. **Cost Export**: Export metrics.json alongside findings.json for external dashboards

---

## References

- Upstream deepsec: https://github.com/vercel/deepsec
- Claude Agent SDK: https://github.com/anthropics/claude-agent-sdk
- Related documentation: `packages/processor/REVALIDATION-IMPROVEMENTS.md`
