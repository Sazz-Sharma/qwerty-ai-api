import { operations, type ApiError, type TransformRequest, type TransformResponse } from "./contracts";
import { PROMPT_VERSION, systemPrompt } from "./prompts";

export interface Env {
  AI_PROVIDER?: string;
  GOOGLE_AI_API_KEY?: string;
  GOOGLE_AI_MODEL?: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  CLIENT_TOKEN?: string;
  MOCK_AI?: string;
}

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    transformed_text: { type: "string", description: "The transformed message requested by the operation." },
    meaning_nepali: { type: ["string", "null"], description: "A concise Devanagari Nepali meaning preview." },
    ambiguity: { type: "string", enum: ["none", "review"] },
  },
  required: ["transformed_text", "meaning_nepali", "ambiguity"],
} as const;

const MAX_INPUT_CHARS = 2_000;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(body: TransformResponse | ApiError | { ok: true; provider: string; model: string; promptVersion: string }, status = 200): Response {
  return Response.json(body, { status, headers: JSON_HEADERS });
}

function parseTransformResult(request: TransformRequest, content: string): TransformResponse {
  const parsed = JSON.parse(content) as {
    transformed_text?: unknown;
    meaning_nepali?: unknown;
    ambiguity?: unknown;
  };
  if (!parsed.transformed_text || typeof parsed.transformed_text !== "string") throw new Error("Provider result failed validation");
  return {
    requestId: request.requestId,
    transformedText: parsed.transformed_text,
    meaningNepali: typeof parsed.meaning_nepali === "string" ? parsed.meaning_nepali : null,
    ambiguity: parsed.ambiguity === "none" ? "none" : "review",
    promptVersion: PROMPT_VERSION,
  };
}

function error(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

export function parseRequest(value: unknown): TransformRequest | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.requestId !== "string" || candidate.requestId.length < 1 || candidate.requestId.length > 100) return null;
  if (typeof candidate.input !== "string" || candidate.input.trim().length < 1 || candidate.input.length > MAX_INPUT_CHARS) return null;
  if (typeof candidate.operation !== "string" || !operations.includes(candidate.operation as TransformRequest["operation"])) return null;
  return candidate as unknown as TransformRequest;
}

function mockTransform(request: TransformRequest): TransformResponse {
  const examples: Record<string, [string, string]> = {
    "translate_to_english:ma bholi aauna sakdina": ["I can't come tomorrow.", "म भोलि आउन सक्दिनँ।"],
    "transliterate_to_nepali:ma bholi aauna sakdina": ["म भोलि आउन सक्दिनँ।", "म भोलि आउन सक्दिनँ।"],
    "make_polite:i can't come tomorrow.": ["I'm sorry, but I won't be able to come tomorrow.", "माफ गर्नुहोस्, म भोलि आउन सक्दिनँ।"],
  };
  const result = examples[`${request.operation}:${request.input.trim().toLowerCase()}`] ?? [
    `[mock ${request.operation}] ${request.input.trim()}`,
    "मक नतिजा — उत्पादनमा Groq जडान गर्नुहोस्।",
  ];
  return { requestId: request.requestId, transformedText: result[0], meaningNepali: result[1], ambiguity: "none", promptVersion: PROMPT_VERSION };
}

async function groqTransform(request: TransformRequest, env: Env): Promise<TransformResponse> {
  if (!env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured");
  const model = env.GROQ_MODEL || "openai/gpt-oss-20b";
  const isQwen = model.startsWith("qwen/");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const providerRequest = JSON.stringify({
        model,
        temperature: 0.1,
        reasoning_effort: isQwen ? "none" : "low",
        include_reasoning: false,
        max_completion_tokens: isQwen ? 512 : 1_024,
        messages: [
          { role: "system", content: systemPrompt(request.operation) },
          { role: "user", content: request.input },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "message_transform",
            strict: true,
            schema: RESULT_SCHEMA,
          },
        },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, "content-type": "application/json" },
        signal: controller.signal,
        body: providerRequest,
      });
      if (!response.ok) {
        const providerMessage = (await response.text()).slice(0, 1_000);
        const retryableSchemaFailure = response.status === 400 && providerMessage.includes("json_validate_failed");
        if (retryableSchemaFailure && attempt === 0) continue;
        throw new Error(`Groq returned ${response.status}: ${providerMessage}`);
      }
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("Groq returned an empty result");
      return parseTransformResult(request, content);
    }
    throw new Error("Groq schema generation failed after retry");
  } finally {
    clearTimeout(timeout);
  }
}

async function googleTransform(request: TransformRequest, env: Env): Promise<TransformResponse> {
  if (!env.GOOGLE_AI_API_KEY) throw new Error("GOOGLE_AI_API_KEY is not configured");
  const model = env.GOOGLE_AI_MODEL || "gemma-4-31b-it";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const providerRequest = JSON.stringify({
      model,
      store: false,
      input: request.input,
      system_instruction: systemPrompt(request.operation),
      generation_config: {
        temperature: 0.1,
        max_output_tokens: 256,
        thinking_level: "minimal",
      },
      response_format: { type: "text", mime_type: "application/json", schema: RESULT_SCHEMA },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: { "x-goog-api-key": env.GOOGLE_AI_API_KEY, "content-type": "application/json" },
        signal: controller.signal,
        body: providerRequest,
      });
      if (!response.ok) {
        const providerMessage = (await response.text()).slice(0, 1_000);
        if ((response.status === 429 || response.status >= 500) && attempt === 0) continue;
        throw new Error(`Google AI returned ${response.status}: ${providerMessage}`);
      }
      const payload = await response.json() as { steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
      const content = payload.steps
        ?.filter((step) => step.type === "model_output")
        .flatMap((step) => step.content || [])
        .filter((part) => part.type === "text")
        .map((part) => part.text || "")
        .join("");
      if (!content) throw new Error("Google AI returned an empty result");
      return parseTransformResult(request, content);
    }
    throw new Error("Google AI failed after retry");
  } finally {
    clearTimeout(timeout);
  }
}

function activeProvider(env: Env): { provider: string; model: string } {
  if (env.AI_PROVIDER === "google") return { provider: "google", model: env.GOOGLE_AI_MODEL || "gemma-4-31b-it" };
  return { provider: "groq", model: env.GROQ_MODEL || "openai/gpt-oss-20b" };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, ...activeProvider(env), promptVersion: PROMPT_VERSION });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/transform") return error("not_found", "Route not found", 404);
    if (env.CLIENT_TOKEN && request.headers.get("authorization") !== `Bearer ${env.CLIENT_TOKEN}`) return error("unauthorized", "Invalid client token", 401);
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return error("bad_content_type", "Use application/json", 415);
    let body: unknown;
    try { body = await request.json(); } catch { return error("invalid_json", "Request body is not valid JSON", 400); }
    const parsed = parseRequest(body);
    if (!parsed) return error("invalid_request", `requestId and operation are required; input must be 1-${MAX_INPUT_CHARS} characters`, 400);
    try {
      const transformed = env.MOCK_AI === "true"
        ? mockTransform(parsed)
        : env.AI_PROVIDER === "google"
          ? await googleTransform(parsed, env)
          : await groqTransform(parsed, env);
      return json(transformed);
    } catch (cause) {
      // Deliberately do not log user message content.
      console.error("transform_failed", cause instanceof Error ? cause.message : "unknown");
      return error("provider_error", "The transformation service is temporarily unavailable", 502);
    }
  },
} satisfies ExportedHandler<Env>;
