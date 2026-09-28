import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import worker, { parseRequest } from "../src/index";

describe("request validation", () => {
  it("accepts an MVP transform", () => {
    expect(parseRequest({ requestId: "r1", operation: "translate_to_english", input: "ma bholi aauchu" })).not.toBeNull();
  });
  it("rejects an empty message", () => {
    expect(parseRequest({ requestId: "r1", operation: "translate_to_english", input: " " })).toBeNull();
  });
  it("accepts the polite follow-up operation", () => {
    expect(parseRequest({ requestId: "r2", operation: "make_polite", input: "I can't come tomorrow." })).not.toBeNull();
  });
});

describe("worker", () => {
  it("exposes health", async () => {
    const response = await SELF.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, provider: "google", model: "gemma-4-31b-it", promptVersion: "mvp-2" });
  });
  it("rejects malformed requests", async () => {
    const response = await SELF.fetch("https://example.com/v1/transform", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(400);
  });
  it("runs the deterministic end-to-end mock", async () => {
    const response = await worker.fetch(new Request("https://example.com/v1/transform", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "demo", operation: "translate_to_english", input: "ma bholi aauna sakdina" }),
    }), { MOCK_AI: "true" });
    expect(response.status).toBe(200);
    const result = await response.json() as { transformedText: string; meaningNepali: string };
    expect(result.transformedText).toBe("I can't come tomorrow.");
    expect(result.meaningNepali).toContain("भोलि");
  });
});
