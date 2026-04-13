/**
 * Module: Embeddings — Voyage AI vector embeddings
 *
 * Generates embeddings for fact text via the Voyage AI API.
 * If VOYAGE_API_KEY is not set, all functions return null/empty — never fatal.
 * Includes retry with exponential backoff for 429/5xx and a request pacer
 * to stay within the 3 RPM free-tier limit.
 */

const EMBEDDING_DIMS = Number(process.env.WHATSON_EMBEDDING_DIMS ?? 512);
const EMBEDDING_MODEL = process.env.WHATSON_EMBEDDING_MODEL ?? "voyage-3-lite";
const BATCH_SIZE = 50;
const MAX_RETRIES = 3;
const MIN_REQUEST_INTERVAL_MS = 21_000; // ~3 RPM → 1 request per 20s, with margin

export function normalizeVector(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

// ── Rate limiter ────────────────────────────────────────────────────────────

let _lastRequestTime = 0;

async function paceRequest(): Promise<void> {
  const now = Date.now();
  const elapsed = now - _lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  _lastRequestTime = Date.now();
}

/** Reset pacer state (for tests). */
export function _resetPacer(): void {
  _lastRequestTime = 0;
}

// ── Retry with backoff ──────────────────────────────────────────────────────

async function voyageRequest(input: string[]): Promise<{ data: { embedding: number[] }[] } | null> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await paceRequest();

    const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input,
        output_dimension: EMBEDDING_DIMS,
      }),
    });

    if (resp.ok) {
      return await resp.json() as { data: { embedding: number[] }[] };
    }

    const status = resp.status;
    const body = await resp.text();

    // Retry on 429 (rate limit) and 5xx (server errors)
    if ((status === 429 || status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(resp.headers.get("retry-after")) || 0;
      const backoff = Math.max(retryAfter * 1000, 2 ** attempt * 2000);
      console.error(`[embeddings] ${status}, retrying in ${Math.round(backoff / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }

    // Non-retryable error
    console.error(`[embeddings] Voyage API ${status}: ${body}`);
    return null;
  }

  return null;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function embedText(text: string): Promise<Float32Array | null> {
  const json = await voyageRequest([text]);
  if (!json) return null;
  return normalizeVector(new Float32Array(json.data[0].embedding));
}

export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
  if (!process.env.VOYAGE_API_KEY) return texts.map(() => null);

  const results: (Float32Array | null)[] = new Array(texts.length).fill(null);

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const chunk = texts.slice(start, start + BATCH_SIZE);

    try {
      const json = await voyageRequest(chunk);
      if (!json) continue;

      for (let i = 0; i < json.data.length; i++) {
        results[start + i] = normalizeVector(new Float32Array(json.data[i].embedding));
      }
    } catch (err) {
      console.error(`[embeddings] Batch chunk failed:`, err);
    }
  }

  return results;
}

// ── Backfill ────────────────────────────────────────────────────────────────

import { getFactsWithoutEmbeddings, getFactsByIds, insertFactEmbedding, hasVecSupport } from "./storage.js";

export async function backfillEmbeddings(): Promise<{ embedded: number; skipped: number }> {
  if (!process.env.VOYAGE_API_KEY || !hasVecSupport()) {
    return { embedded: 0, skipped: 0 };
  }

  const missingIds = await getFactsWithoutEmbeddings();
  if (missingIds.length === 0) return { embedded: 0, skipped: 0 };

  console.error(`[embeddings] Backfilling ${missingIds.length} facts`);
  let embedded = 0;
  let skipped = 0;

  // Process in batches
  for (let start = 0; start < missingIds.length; start += BATCH_SIZE) {
    const batchIds = missingIds.slice(start, start + BATCH_SIZE);
    const facts = await getFactsByIds(batchIds);
    const texts = facts.map((f) => f.content);

    const vectors = await embedBatch(texts);

    for (let i = 0; i < facts.length; i++) {
      if (vectors[i]) {
        await insertFactEmbedding(facts[i].id!, vectors[i]!);
        embedded++;
      } else {
        skipped++;
      }
    }
  }

  console.error(`[embeddings] Backfill complete: ${embedded} embedded, ${skipped} skipped`);
  return { embedded, skipped };
}
