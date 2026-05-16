/**
 * Custom per-model pricing configuration for cost estimation.
 *
 * By default, Claude Agent SDK uses API-reported costs and Codex SDK uses
 * hardcoded rates. This module allows overriding with custom rates via
 * environment variables - useful when routing through a custom LLM gateway
 * (e.g., AMD LLM Gateway) with different pricing.
 *
 * Environment variables (all rates in USD per 1M tokens):
 *
 * Per-model pricing (recommended):
 *   DEEPSEC_PRICING_OPUS_INPUT      - Opus input token rate
 *   DEEPSEC_PRICING_OPUS_CACHED     - Opus cached input token rate
 *   DEEPSEC_PRICING_OPUS_OUTPUT     - Opus output token rate
 *   DEEPSEC_PRICING_SONNET_INPUT    - Sonnet input token rate
 *   DEEPSEC_PRICING_SONNET_CACHED   - Sonnet cached input token rate
 *   DEEPSEC_PRICING_SONNET_OUTPUT   - Sonnet output token rate
 *   DEEPSEC_PRICING_HAIKU_INPUT     - Haiku input token rate
 *   DEEPSEC_PRICING_HAIKU_CACHED    - Haiku cached input token rate
 *   DEEPSEC_PRICING_HAIKU_OUTPUT    - Haiku output token rate
 *
 * Fallback pricing (applies to all models without specific config):
 *   DEEPSEC_PRICING_INPUT           - Default input token rate
 *   DEEPSEC_PRICING_CACHED          - Default cached input token rate
 *   DEEPSEC_PRICING_OUTPUT          - Default output token rate
 *
 * Example for AMD LLM Gateway:
 *   DEEPSEC_PRICING_OPUS_INPUT=15.0
 *   DEEPSEC_PRICING_OPUS_OUTPUT=75.0
 *   DEEPSEC_PRICING_SONNET_INPUT=3.0
 *   DEEPSEC_PRICING_SONNET_OUTPUT=15.0
 *   DEEPSEC_PRICING_HAIKU_INPUT=0.25
 *   DEEPSEC_PRICING_HAIKU_OUTPUT=1.25
 */

export interface PricingRates {
  input: number;
  cachedInput: number;
  output: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

type ModelTier = "opus" | "sonnet" | "haiku" | "default";

const _pricingCache: Map<ModelTier, PricingRates | null> = new Map();
let _initialized = false;

function parseEnvFloat(key: string): number | undefined {
  const val = process.env[key];
  if (!val) return undefined;
  const num = parseFloat(val);
  return isNaN(num) ? undefined : num;
}

function loadPricingForTier(tier: ModelTier): PricingRates | null {
  const prefix = tier === "default" ? "DEEPSEC_PRICING" : `DEEPSEC_PRICING_${tier.toUpperCase()}`;

  const input = parseEnvFloat(`${prefix}_INPUT`);
  const cached = parseEnvFloat(`${prefix}_CACHED`);
  const output = parseEnvFloat(`${prefix}_OUTPUT`);

  if (input !== undefined || cached !== undefined || output !== undefined) {
    return {
      input: input ?? 3.0,
      cachedInput: cached ?? (input ? input * 0.1 : 0.3),
      output: output ?? 15.0,
    };
  }
  return null;
}

function initializePricing(): void {
  if (_initialized) return;
  _initialized = true;

  const tiers: ModelTier[] = ["opus", "sonnet", "haiku", "default"];
  const configured: string[] = [];

  for (const tier of tiers) {
    const rates = loadPricingForTier(tier);
    _pricingCache.set(tier, rates);
    if (rates) {
      const label = tier === "default" ? "fallback" : tier;
      configured.push(`${label}=$${rates.input}/$${rates.cachedInput}/$${rates.output}`);
    }
  }

  if (configured.length > 0) {
    console.error(`[pricing] Custom rates (input/cached/output per 1M): ${configured.join(", ")}`);
  }
}

function modelToTier(model: string): ModelTier {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  // GPT models - map to approximate Claude equivalent by capability
  if (m.includes("gpt-5.5") || m.includes("gpt-5.4-pro")) return "opus";
  if (m.includes("gpt-5.4") && !m.includes("mini") && !m.includes("nano")) return "sonnet";
  if (m.includes("mini") || m.includes("nano")) return "haiku";
  return "default";
}

export function getCustomPricing(model?: string): PricingRates | null {
  initializePricing();

  if (model) {
    const tier = modelToTier(model);
    const tierRates = _pricingCache.get(tier);
    if (tierRates) return tierRates;
  }

  // Fall back to default rates
  return _pricingCache.get("default") ?? null;
}

export function hasCustomPricing(model?: string): boolean {
  return getCustomPricing(model) !== null;
}

export function calculateCostUsd(usage: TokenUsage, model?: string): number {
  const rates = getCustomPricing(model);
  if (!rates) {
    throw new Error("calculateCostUsd called without custom pricing configured");
  }

  const cached = usage.cacheReadInputTokens ?? 0;
  const uncachedInput = usage.inputTokens;
  const output = usage.outputTokens;

  return (uncachedInput * rates.input + cached * rates.cachedInput + output * rates.output) / 1_000_000;
}

export function maybeOverrideCost(
  apiCost: number | undefined,
  usage?: TokenUsage,
  model?: string,
): number | undefined {
  const customRates = getCustomPricing(model);
  if (!customRates || !usage) return apiCost;
  return calculateCostUsd(usage, model);
}

export function resetPricingCache(): void {
  _pricingCache.clear();
  _initialized = false;
}
