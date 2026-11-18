/**
 * Minimal client for the OpenAI Responses API, used statelessly: nothing is stored on the provider's
 * side, and each call carries the whole transcript. The transcript is the list of items the API
 * itself returned (plus our user messages and tool outputs), so it can be replayed after a crash.
 */

export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
}

/** An input or output item in the API's own shape. Stored verbatim. */
export type Item = Record<string, any>;

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  total_tokens: number;
}

export interface ModelResponse {
  output: Item[];
  usage: ModelUsage;
}

export interface ModelRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  instructions: string;
  input: Item[];
  tools: ToolDefinition[];
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const RETRY_DELAYS_MS = [1_000, 4_000, 10_000];

export async function respond(request: ModelRequest): Promise<ModelResponse> {
  let lastError: ModelError | undefined;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
    try {
      return await once(request);
    } catch (err) {
      if (!(err instanceof ModelError) || !err.retryable) throw err;
      lastError = err;
    }
  }
  throw lastError ?? new ModelError("model call failed", 0, false);
}

async function once(request: ModelRequest): Promise<ModelResponse> {
  let response: Response;
  try {
    response = await fetch(`${request.baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${request.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        instructions: request.instructions,
        input: request.input,
        tools: request.tools,
        store: false,
        // Without server-side storage, reasoning has to travel with the transcript.
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "low" },
        parallel_tool_calls: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new ModelError(`model request did not complete: ${String(err)}`, 0, true);
  }
  const text = await response.text();
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new ModelError(`model returned ${response.status}: ${text.slice(0, 500)}`, response.status, retryable);
  }
  const body = JSON.parse(text) as { status?: string; output?: Item[]; usage?: any; error?: { message?: string } };
  if (body.status !== "completed" || !Array.isArray(body.output)) {
    throw new ModelError(`model response was ${body.status}: ${body.error?.message ?? "no output"}`, 200, false);
  }
  return {
    output: body.output,
    usage: {
      input_tokens: body.usage?.input_tokens ?? 0,
      output_tokens: body.usage?.output_tokens ?? 0,
      cached_tokens: body.usage?.input_tokens_details?.cached_tokens ?? 0,
      total_tokens: body.usage?.total_tokens ?? 0,
    },
  };
}

/** The text of an assistant message item, or "" if it has none. */
export function messageText(item: Item): string {
  if (item.type !== "message" || !Array.isArray(item.content)) return "";
  return item.content
    .filter((part: any) => part?.type === "output_text" || part?.type === "input_text")
    .map((part: any) => part.text ?? "")
    .join("");
}
