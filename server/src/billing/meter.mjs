// Counting the tokens of a model answer as it passes through. OpenAI-style
// services report usage in the last event of a stream (Responses:
// response.completed; Chat Completions: the final chunk when asked with
// stream_options.include_usage) or in `usage` of a whole answer. When none is
// reported (the user stopped the answer, the service left it out) the count is
// estimated from the text and marked as such.

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Usage in either API's shape, or null without one. */
export function usageOf(value) {
  if (!value || typeof value !== 'object') return null;
  const input = number(value.input_tokens) ?? number(value.prompt_tokens);
  if (input === null) return null;
  const cached =
    number(value.input_tokens_details?.cached_tokens) ??
    number(value.prompt_tokens_details?.cached_tokens) ??
    number(value.prompt_cache_hit_tokens) ??
    0;
  const output = number(value.output_tokens) ?? number(value.completion_tokens) ?? 0;
  const reasoning =
    number(value.output_tokens_details?.reasoning_tokens) ??
    number(value.completion_tokens_details?.reasoning_tokens) ??
    0;
  return { input, cached: Math.min(cached, input), output, reasoning };
}

/** About two characters a token: between Chinese (about one) and English (about four). */
export const guessTokens = (chars) => Math.ceil(chars / 2);

/** Characters of text in a request, leaving out pictures and files sent inline. */
export function textChars(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.startsWith('data:') ? 0 : value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + textChars(item, depth + 1), 0);
  if (typeof value === 'object') {
    let sum = 0;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'image_url' || key === 'file_data' || key === 'image') continue;
      sum += textChars(item, depth + 1);
    }
    return sum;
  }
  return 0;
}

/** The text a request sends to the model. */
export const promptChars = (input) =>
  textChars(input.instructions) + textChars(input.input) + textChars(input.messages) + textChars(input.tools);

const deltaChars = (event) => {
  let chars = 0;
  // Responses: output text, reasoning summaries, tool-call arguments.
  if (typeof event.delta === 'string') chars += event.delta.length;
  // Chat Completions.
  for (const choice of Array.isArray(event.choices) ? event.choices : []) {
    const delta = choice?.delta ?? {};
    if (typeof delta.content === 'string') chars += delta.content.length;
    if (typeof delta.reasoning_content === 'string') chars += delta.reasoning_content.length;
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (typeof call?.function?.arguments === 'string') chars += call.function.arguments.length;
    }
  }
  return chars;
};

/** Reads an event stream (data: lines) or a whole JSON answer while it is relayed. */
export function createMeter() {
  let pending = '';
  let whole = '';
  let streaming = null;
  let reported = null;
  let outputChars = 0;

  const readEvent = (data) => {
    if (!data || data === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    reported = usageOf(event.response?.usage) ?? usageOf(event.usage) ?? reported;
    outputChars += deltaChars(event);
  };

  return {
    /** Text of the answer as it comes, in pieces of any size. */
    push(text) {
      if (streaming === null) {
        const start = text.trimStart();
        if (!start) return;
        streaming = !start.startsWith('{');
      }
      if (!streaming) {
        // A whole answer is read at the end; keep at most 8 MiB of it.
        if (whole.length < 8 * 1024 * 1024) whole += text;
        return;
      }
      pending += text;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        if (line.startsWith('data:')) readEvent(line.slice(5).trim());
      }
    },
    /** The reported count, or an estimate from the prompt and the answer's text. */
    finish(prompt) {
      if (!streaming && whole) {
        try {
          const value = JSON.parse(whole);
          reported = usageOf(value.usage) ?? usageOf(value.response?.usage) ?? reported;
          if (!reported) outputChars += textChars(value.output ?? value.choices);
        } catch {
          // Not JSON: nothing to count but its length.
          outputChars += whole.length;
        }
      } else if (pending.startsWith('data:')) readEvent(pending.slice(5).trim());
      if (reported) return { ...reported, estimated: false };
      return {
        input: guessTokens(prompt),
        cached: 0,
        output: guessTokens(outputChars),
        reasoning: 0,
        estimated: true,
      };
    },
  };
}

/** Points to charge and the upstream cost in millionths of a yuan for a count of tokens. */
export function charge(model, tokens) {
  const uncached = Math.max(0, tokens.input - tokens.cached);
  const points = Math.ceil(
    (uncached * model.priceInput + tokens.cached * model.priceCached + tokens.output * model.priceOutput) /
      1_000_000,
  );
  const cost = Math.round(
    uncached * model.costInput + tokens.cached * model.costCached + tokens.output * model.costOutput,
  );
  return { points, costMicros: cost };
}

// Share of each kind of token in typical use, for comparing models and estimating margins.
export const TYPICAL_MIX = { input: 0.4, cached: 0.52, output: 0.08 };

/** Points and cost of a typical million tokens, from which multipliers and margins follow. */
export function typical(model, mix = TYPICAL_MIX) {
  const sale =
    (mix.input * model.priceInput + mix.cached * model.priceCached + mix.output * model.priceOutput) / 100;
  const cost = mix.input * model.costInput + mix.cached * model.costCached + mix.output * model.costOutput;
  return { sale, cost, margin: sale > 0 ? Math.round((1 - cost / sale) * 100) : null };
}
