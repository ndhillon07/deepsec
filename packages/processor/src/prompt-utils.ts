/**
 * Utilities for AI prompt construction and response parsing.
 * Provides reusable prompt fragments and JSON extraction logic.
 */

/**
 * Strict JSON-only output instruction to prevent LLM from adding
 * explanatory text before/after JSON responses.
 *
 * Use this when you need the LLM to return ONLY valid JSON with no preamble.
 */
export const STRICT_JSON_OUTPUT_INSTRUCTION = `**CRITICAL: Return ONLY the JSON array. No explanatory text before or after. No markdown code fences. No commentary. Just the raw JSON array starting with [ and ending with ].**`;

/**
 * Extract JSON array from LLM response text.
 * Handles common cases:
 * - Pure JSON: [...]
 * - Markdown fence: \`\`\`json [...]\`\`\`
 * - Verbose response: "Here are my findings: [...]"
 *
 * @param text - Raw LLM response text
 * @returns Extracted JSON string (may still need JSON.parse)
 */
export function extractJsonArray(text: string): string {
  // Try to extract from markdown code fence first
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  let jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();

  // If no code fence, try to find JSON array boundaries
  if (!jsonMatch) {
    const arrayStart = jsonStr.indexOf('[');
    const arrayEnd = jsonStr.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
      jsonStr = jsonStr.substring(arrayStart, arrayEnd + 1);
    }
  }

  return jsonStr;
}
