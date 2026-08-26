// Tokenizer hierarchy: best-practical token counting with graceful fallback.
// Never calls remote APIs. Deterministic.

export type TokenCountMethod = "provider_tokenizer" | "model_family_tokenizer" | "local_tokenizer" | "conservative_estimate"

export interface TokenCountResult {
  tokens: number
  method: TokenCountMethod
  confidence: "high" | "medium" | "low"
}

type TokenizerFn = (text: string) => number

/** Model family → tokenizer mapping. Extend as providers are added. */
const FAMILY_TOKENIZERS: Record<string, TokenizerFn> = {
  // Approximate: most modern LLM families average ~3.5-4 chars/token for code
  qwen: (text) => Math.ceil(text.length / 3.8),
  llama: (text) => Math.ceil(text.length / 3.9),
  mistral: (text) => Math.ceil(text.length / 3.7),
  phi: (text) => Math.ceil(text.length / 4.0),
  deepseek: (text) => Math.ceil(text.length / 3.6),
}

function detectModelFamily(modelID: string): string | undefined {
  const lower = modelID.toLowerCase()
  for (const family of Object.keys(FAMILY_TOKENIZERS)) {
    if (lower.includes(family)) return family
  }
  return undefined
}

function conservativeEstimate(text: string): TokenCountResult {
  return { tokens: Math.ceil(text.length / 4), method: "conservative_estimate", confidence: "low" }
}

/**
 * Counts tokens using the best available method.
 * Falls back to conservative estimate when no model-specific tokenizer exists.
 */
export function countTokens(text: string, modelID?: string): TokenCountResult {
  if (!text) return { tokens: 0, method: "conservative_estimate", confidence: "high" }

  if (modelID) {
    const family = detectModelFamily(modelID)
    const tokenizer = family ? FAMILY_TOKENIZERS[family] : undefined
    if (tokenizer) {
      return {
        tokens: tokenizer(text),
        method: "model_family_tokenizer",
        confidence: "medium",
      }
    }
  }

  // Local heuristic tokenizer: split on word boundaries and count subwords
  // This is better than pure character counting for natural language
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length > 0) {
    // Average English/code word ≈ 1.3 tokens
    let tokens = Math.ceil(words.length * 1.3)
    // Add extra for long words (likely identifiers/paths)
    for (const word of words) {
      if (word.length > 20) tokens += Math.ceil((word.length - 20) / 4)
    }
    return { tokens, method: "local_tokenizer", confidence: "medium" }
  }

  return conservativeEstimate(text)
}
