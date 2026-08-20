import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { ImageInputError, normalizeImageInput } from "../src/utils/image-input.ts";
import { OPENAI_CODEX_MODELS } from "../src/providers/openai-codex.models.ts";
import type { Context, Model } from "../src/types.ts";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZfXQAAAAASUVORK5CYII=";

describe("image input normalization", () => {
	it("reports the ChatGPT Codex route as text-only until live image parity is proven", () => {
		for (const model of Object.values(OPENAI_CODEX_MODELS)) expect(model.input).toEqual(["text"]);
	});

  it("accepts raw base64 or one complete matching data URL and returns canonical raw data", () => {
    expect(normalizeImageInput({ type: "image", mimeType: "image/png", data: PNG_BASE64 })).toEqual({
      type: "image",
      mimeType: "image/png",
      data: PNG_BASE64,
    });
    expect(normalizeImageInput({ type: "image", mimeType: "image/png", data: `data:image/png;base64,${PNG_BASE64}` })).toEqual({
      type: "image",
      mimeType: "image/png",
      data: PNG_BASE64,
    });
  });

  it("rejects mismatched MIME, malformed base64, and bytes with the wrong signature", () => {
    expect(() => normalizeImageInput({ type: "image", mimeType: "image/jpeg", data: `data:image/png;base64,${PNG_BASE64}` })).toThrow(ImageInputError);
    expect(() => normalizeImageInput({ type: "image", mimeType: "image/png", data: "%%%" })).toThrow(/base64/i);
    expect(() => normalizeImageInput({ type: "image", mimeType: "image/png", data: Buffer.from("not png").toString("base64") })).toThrow(/do not match/i);
  });

  it("emits the official Responses input_image data URL shape for Codex models", () => {
    const model: Model<"openai-codex-responses"> = {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    };
    const context: Context = {
      systemPrompt: "test",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image", mimeType: "image/png", data: `data:image/png;base64,${PNG_BASE64}` },
        ],
        timestamp: Date.now(),
      }],
    };
    const input = convertResponsesMessages(model, context, new Set(["openai-codex"]), { includeSystemPrompt: false });
    expect(input).toEqual([{
      role: "user",
      content: [
        { type: "input_text", text: "inspect" },
        { type: "input_image", detail: "auto", image_url: `data:image/png;base64,${PNG_BASE64}` },
      ],
    }]);
  });
});
