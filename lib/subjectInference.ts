// =============================================================================
// Subject Inference — LLM-based subject classification for books
// =============================================================================
// inferSubjectsFromLLM — given a book's title, author, and description, asks
// an OpenAI-compatible LLM to assign subjects from a curated vocabulary.
//
// Design principles:
//   • Conservative: only 2-5 subjects; prefer high-confidence specific terms.
//   • Constrained: output must come from SUBJECT_VOCABULARY exactly.
//   • Bounded: skips books with missing or thin descriptions (< MIN_DESC_CHARS).
//   • Node-safe: no React Native or Expo imports; usable from CLI scripts.
//   • Fail-soft: every error path returns null so the caller can move on.
//
// This is a batch-maintenance helper — it is intentionally NOT called from
// any live app path.  LLM calls belong in scripts/inferSubjectsLLM.ts only.
//
// Configuration:
//   OPENAI_API_KEY  — required; any OpenAI-compatible key
//   LLM_MODEL       — optional; default is gpt-4o-mini
//                     Override with e.g. gpt-5-mini when using Replit AI integration
// =============================================================================

import OpenAI from 'openai';
import { SUBJECT_VOCABULARY, SUBJECT_VOCABULARY_SET } from './subjectVocabulary';

export const MIN_DESC_CHARS = 100;

const MODEL = process.env.LLM_MODEL ?? 'gpt-4o-mini';

// Lazy singleton — created on first use so the module can be imported without
// a key present (e.g. in tests or dry-run paths that skip inference entirely).
let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error('[SUBJECT_INFERENCE] OPENAI_API_KEY is not set — cannot call LLM');
    }
    _client = new OpenAI({ apiKey: key });
  }
  return _client;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const VOCAB_BLOCK = SUBJECT_VOCABULARY.join(', ');

const SYSTEM_PROMPT = `\
You are a librarian who assigns subject tags to books.

Given a book's title, author, and description, return 2–5 subjects that accurately describe its genre, themes, and audience. Choose only from the vocabulary below. Each subject must match the vocabulary exactly (same spelling, spacing, and case).

Be conservative:
- Only include subjects you are confident about based on the description.
- Prefer specific terms (e.g. "psychological thriller") over vague ones (e.g. "thriller") when the description supports it.
- Do not add audience labels (e.g. "young adult fiction") unless the description or context clearly targets that age group.
- Do not include subjects that merely tangentially appear in the description.

Vocabulary (choose only from these, exact match required):
${VOCAB_BLOCK}

Respond with JSON only, using this exact schema:
{"subjects": ["term1", "term2"]}`;

function buildUserPrompt(title: string, author: string, description: string): string {
  const safeDesc = description.slice(0, 1500); // cap at ~300 words to control tokens
  return `Title: ${title}\nAuthor: ${author}\nDescription: ${safeDesc}`;
}

// ── Output validation ─────────────────────────────────────────────────────────

/**
 * Parse and validate the raw JSON string from the LLM.
 * Returns only terms that are exact members of SUBJECT_VOCABULARY.
 * Returns null if the response is unparseable or empty after filtering.
 */
function parseAndValidate(raw: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log(`[SUBJECT_INFERENCE] JSON parse error — raw: ${raw.slice(0, 200)}`);
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).subjects)
  ) {
    console.log('[SUBJECT_INFERENCE] response missing subjects array');
    return null;
  }

  const rawTerms = ((parsed as Record<string, unknown>).subjects as unknown[])
    .filter((t): t is string => typeof t === 'string')
    .map(t => t.toLowerCase().trim());

  const valid = rawTerms.filter(t => SUBJECT_VOCABULARY_SET.has(t));
  const invalid = rawTerms.filter(t => !SUBJECT_VOCABULARY_SET.has(t));

  if (invalid.length > 0) {
    console.log(`[SUBJECT_INFERENCE] rejected out-of-vocab terms: ${invalid.join(', ')}`);
  }

  return valid.length > 0 ? valid : null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export type InferenceResult = {
  subjects:    string[];
  model:       string;
  inputTokens: number;
  outputTokens: number;
};

/**
 * Infer subjects for a single book using the LLM.
 *
 * Returns null when:
 *   - description is missing or too short (< MIN_DESC_CHARS)
 *   - the LLM returns no valid vocabulary terms
 *   - any network / API error occurs
 *
 * The caller is responsible for the idempotency guard (checking whether
 * this book has already been inferred) before calling this function.
 */
export async function inferSubjectsFromLLM(
  title:       string,
  author:      string,
  description: string | null,
): Promise<InferenceResult | null> {
  if (!description || description.length < MIN_DESC_CHARS) {
    return null;
  }

  const t = title.trim();
  const a = author.trim();
  const d = description.trim();

  if (!t) return null;

  try {
    const client = getClient();
    const response = await client.chat.completions.create({
      model:  MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildUserPrompt(t, a, d) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens:  200,
    });

    const raw = response.choices[0]?.message?.content ?? '';
    const subjects = parseAndValidate(raw);

    if (!subjects) return null;

    return {
      subjects,
      model:        response.model,
      inputTokens:  response.usage?.prompt_tokens    ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    console.log(`[SUBJECT_INFERENCE] API error for "${t}" — ${String(err)}`);
    return null;
  }
}
