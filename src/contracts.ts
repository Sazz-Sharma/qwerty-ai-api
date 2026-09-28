export const operations = ["translate_to_english", "transliterate_to_nepali", "make_polite"] as const;
export type Operation = (typeof operations)[number];

export interface TransformRequest {
  requestId: string;
  operation: Operation;
  input: string;
}

export interface TransformResponse {
  requestId: string;
  transformedText: string;
  meaningNepali: string | null;
  ambiguity: "none" | "review";
  promptVersion: string;
}

export interface ApiError {
  error: { code: string; message: string };
}
