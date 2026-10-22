/**
 * Illustrative list prices in USD per 1M tokens. These are placeholders, not real pricing.
 *
 * Costs are stored as integer micro-dollars to avoid floating-point drift when summing:
 *   USD = tokens / 1e6 * price   =>   micro-USD = tokens * price
 */
export const MODEL_PRICES = {
  "llama-3.3-70b": { input: 0.85, output: 1.2 },
  "llama3.1-8b": { input: 0.1, output: 0.1 },
  "qwen-3-32b": { input: 0.4, output: 0.8 },
  "gpt-oss-120b": { input: 0.35, output: 0.75 },
} as const satisfies Record<string, { input: number; output: number }>;

export type ModelId = keyof typeof MODEL_PRICES;

export const MODELS = Object.keys(MODEL_PRICES) as ModelId[];

export function isKnownModel(model: string): model is ModelId {
  return Object.prototype.hasOwnProperty.call(MODEL_PRICES, model);
}

export function estimateCostMicros(model: ModelId, inputTokens: number, outputTokens: number): number {
  const price = MODEL_PRICES[model];
  return Math.round(inputTokens * price.input + outputTokens * price.output);
}

export function microsToUsd(micros: number): number {
  return micros / 1_000_000;
}
