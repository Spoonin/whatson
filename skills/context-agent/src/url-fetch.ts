/**
 * URL detection and web page text extraction.
 *
 * Uses Node's native fetch (Node 24+) and a simple HTML-to-text
 * converter — no external dependencies.
 */

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB cap
const FETCH_TIMEOUT_MS = 15_000;

/** Extract all URLs from a message string. */
export function extractUrls(message: string): string[] {
  const matches = message.match(URL_REGEX);
  if (!matches) return [];
  // Deduplicate, preserve order
  return [...new Set(matches)];
}

/** Strip the URL(s) from the message, returning the remaining plain text. */
export function stripUrls(message: string): string {
  return message.replace(URL_REGEX, "").replace(/\s{2,}/g, " ").trim();
}

/** Fetch a URL and return readable text content. */
export async function fetchPageText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
        Accept: "text/html, application/json, text/plain",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      return `[fetch error: ${res.status} ${res.statusText}]`;
    }

    const contentType = res.headers.get("content-type") ?? "";
    const body = await readLimited(res, MAX_BODY_BYTES);

    if (contentType.includes("application/json")) {
      return body;
    }

    if (contentType.includes("text/plain")) {
      return body;
    }

    // HTML → readable text
    return htmlToText(body);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[fetch error: ${msg}]`;
  } finally {
    clearTimeout(timer);
  }
}

/** Read response body up to a byte limit. */
async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      chunks.push(value.slice(0, value.byteLength - (totalBytes - maxBytes)));
      break;
    }
    chunks.push(value);
  }

  const decoder = new TextDecoder();
  return chunks.map((c) => decoder.decode(c, { stream: true })).join("") +
    decoder.decode();
}

/** Simple HTML-to-text: strip tags, decode entities, collapse whitespace. */
export function htmlToText(html: string): string {
  let text = html;

  // Remove script/style blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "");

  // Block elements → newline
  text = text.replace(/<\/?(?:p|div|br|h[1-6]|li|tr|blockquote|section|article)[^>]*>/gi, "\n");

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "");

  // Collapse whitespace
  text = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

  return text;
}
