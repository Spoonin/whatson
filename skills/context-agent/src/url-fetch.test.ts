import { describe, it, expect } from "vitest";
import { extractUrls, stripUrls, htmlToText } from "./url-fetch.js";

describe("extractUrls", () => {
  it("extracts a single URL", () => {
    const urls = extractUrls("Check https://example.com/page for details");
    expect(urls).toEqual(["https://example.com/page"]);
  });

  it("extracts multiple URLs", () => {
    const urls = extractUrls("See https://a.com and http://b.com/path?q=1");
    expect(urls).toEqual(["https://a.com", "http://b.com/path?q=1"]);
  });

  it("deduplicates URLs", () => {
    const urls = extractUrls("https://a.com and https://a.com again");
    expect(urls).toEqual(["https://a.com"]);
  });

  it("returns empty for no URLs", () => {
    expect(extractUrls("Just plain text")).toEqual([]);
  });

  it("handles URLs at end of sentence", () => {
    const urls = extractUrls("Visit https://example.com.");
    expect(urls[0]).toBe("https://example.com.");
  });
});

describe("stripUrls", () => {
  it("removes URLs and collapses whitespace", () => {
    const result = stripUrls("Check https://example.com for info");
    expect(result).toBe("Check for info");
  });

  it("returns empty for URL-only messages", () => {
    const result = stripUrls("https://example.com");
    expect(result).toBe("");
  });

  it("preserves text without URLs", () => {
    expect(stripUrls("No links here")).toBe("No links here");
  });
});

describe("htmlToText", () => {
  it("strips simple HTML tags", () => {
    expect(htmlToText("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("removes script blocks", () => {
    expect(htmlToText("Text<script>alert(1)</script>More")).toBe("TextMore");
  });

  it("removes style blocks", () => {
    expect(htmlToText("A<style>.x{color:red}</style>B")).toBe("AB");
  });

  it("removes nav and footer", () => {
    const html = "<nav>Menu</nav><article>Content</article><footer>Links</footer>";
    expect(htmlToText(html)).toContain("Content");
    expect(htmlToText(html)).not.toContain("Menu");
    expect(htmlToText(html)).not.toContain("Links");
  });

  it("decodes HTML entities", () => {
    expect(htmlToText("&amp; &lt; &gt; &quot;")).toBe('& < > "');
  });

  it("collapses whitespace", () => {
    expect(htmlToText("<p>  lots   of   spaces  </p>")).toBe("lots of spaces");
  });
});
