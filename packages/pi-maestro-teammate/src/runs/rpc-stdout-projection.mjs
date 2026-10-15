// Project only telemetry; the model and persisted session retain the originals.
// Keep these below the parent's 4 MiB framing limit, including JSON escaping.
const FIELD_BYTES = 64 * 1024;
const CONTENT_BYTES = 256 * 1024;
const HISTORY_BYTES = 512 * 1024;
const HISTORY_ITEMS = 128;

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function truncateText(value, budget) {
  const bytes = byteLength(value);
  const limit = Math.min(FIELD_BYTES, budget.remaining);
  if (bytes <= limit) {
    budget.remaining -= bytes;
    return value;
  }
  const notice = `\n[teammate telemetry truncated: ${bytes} serialized bytes; original retained in child session]`;
  let start = 0;
  let end = Math.min(value.length, FIELD_BYTES);
  // Budget the serialized text, not its raw characters: JSON escaping can
  // expand a single byte to six, and Unicode must survive the prefix cut.
  while (start < end) {
    const middle = Math.ceil((start + end) / 2);
    if (byteLength(value.slice(0, middle) + notice) <= limit) start = middle;
    else end = middle - 1;
  }
  if (start > 0 && /[\uD800-\uDBFF]/.test(value[start - 1])) start -= 1;
  const projected = value.slice(0, start) + notice;
  budget.remaining = Math.max(0, budget.remaining - byteLength(projected));
  return projected;
}

function projectPayload(value, budget) {
  if (value === undefined) return value;
  const bytes = byteLength(value);
  const projected = bytes <= Math.min(FIELD_BYTES, budget.remaining) ? value : {
    teammateTelemetryOmitted: true,
    originalBytes: bytes,
    reason: "Original retained in child session",
  };
  budget.remaining = Math.max(0, budget.remaining - byteLength(projected));
  return projected;
}

function isStructuredOutput(value) {
  return (value?.toolName ?? value?.name) === "structured_output";
}

function isToolCall(value) {
  return value?.type === "toolCall" || value?.type === "tool_use"
    || value?.name === "structured_output" || value?.toolName === "structured_output";
}

// Retain semantic blocks even if they exceed a display budget. The existing
// framing guard must still reject unprojectable control/structured payloads.
function boundItems(items, maxBytes, required = () => false) {
  let bytes = 2;
  const retained = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const size = byteLength(item) + 1;
    if (retained.length === 0 || required(item, index)
      || (retained.length < HISTORY_ITEMS && bytes + size <= maxBytes)) {
      retained.push(item);
      bytes += size;
    }
  }
  return retained.reverse();
}

function withOmissions(value, key, count) {
  if (count === 0) return value;
  return { ...value, teammateTelemetry: { ...value.teammateTelemetry, [key]: count } };
}

function projectBlock(part, preserveText, budget) {
  if (!part || typeof part !== "object") return part;
  if (part.type === "image" && typeof part.data === "string") {
    return { type: "text", text: `[image omitted from teammate telemetry: ${Buffer.byteLength(part.data)} encoded bytes]` };
  }
  let projected = part;
  const set = (key, value) => {
    if (value !== part[key]) projected = { ...projected, [key]: value };
  };
  for (const key of ["text", "thinking", "thinkingSignature", "textSignature"]) {
    if (!preserveText && typeof part[key] === "string") set(key, truncateText(part[key], budget));
  }
  if (isToolCall(part) && !isStructuredOutput(part)) {
    for (const key of ["arguments", "input"]) {
      if (part[key] !== undefined) set(key, projectPayload(part[key], budget));
    }
  }
  return projected;
}

function projectContent(value, budget, structured = false) {
  if (!value || typeof value !== "object") return value;
  let projected = value;
  const preserveText = value.role === "user";
  if (Array.isArray(value.content)) {
    const parts = value.content.map((part) => projectBlock(part, preserveText, budget));
    const content = preserveText ? parts : boundItems(parts, CONTENT_BYTES, isToolCall);
    if (content.length !== value.content.length || content.some((part, index) => part !== value.content[index])) {
      projected = { ...projected, content };
    }
    projected = withOmissions(projected, "omittedContentBlocks", parts.length - content.length);
  } else if (!preserveText && typeof value.content === "string") {
    const content = truncateText(value.content, budget);
    if (content !== value.content) projected = { ...projected, content };
  }
  if (!structured && !isStructuredOutput(value) && value.details !== undefined) {
    const details = projectPayload(value.details, budget);
    if (details !== value.details) projected = { ...projected, details };
  }
  for (const key of ["errorMessage", "error"]) {
    if (typeof value[key] === "string") {
      const text = truncateText(value[key], budget);
      if (text !== value[key]) projected = { ...projected, [key]: text };
    }
  }
  return projected;
}

export function projectRpcEvent(event) {
  const structured = isStructuredOutput(event);
  const budget = { remaining: HISTORY_BYTES };
  let projected = { ...projectContent(event, budget, structured) };
  if (!structured && event.args !== undefined) projected.args = projectPayload(event.args, budget);
  for (const key of ["message", "result", "partialResult"]) {
    if (event[key]) projected[key] = projectContent(event[key], budget, structured);
  }
  for (const key of ["messages", "toolResults"]) {
    if (!Array.isArray(event[key])) continue;
    const items = event[key].slice().reverse().map((item) => projectContent(item, budget)).reverse();
    const latestAssistant = items.findLastIndex((item) => item?.role === "assistant");
    const bounded = boundItems(items, HISTORY_BYTES, (_item, index) => index === latestAssistant);
    projected[key] = bounded;
    projected = withOmissions(projected, `omitted${key === "messages" ? "Messages" : "ToolResults"}`, items.length - bounded.length);
  }
  if (event.assistantMessageEvent) {
    const update = { ...event.assistantMessageEvent };
    for (const key of ["delta", "content"]) {
      if (typeof update[key] === "string") update[key] = truncateText(update[key], budget);
    }
    if (update.partial) update.partial = projectContent(update.partial, budget);
    if (update.message) update.message = projectContent(update.message, budget);
    if (update.error) update.error = typeof update.error === "string"
      ? truncateText(update.error, budget) : projectContent(update.error, budget);
    if (update.toolCall) update.toolCall = projectBlock(update.toolCall, false, budget);
    projected.assistantMessageEvent = update;
  }
  return projected;
}

export function projectRpcWrite(chunk) {
  if (typeof chunk !== "string" || !chunk.endsWith("\n")) return chunk;
  if (chunk.length * 3 <= FIELD_BYTES && !chunk.includes('"image"')) return chunk;
  if (Buffer.byteLength(chunk) <= FIELD_BYTES && !chunk.includes('"image"')) return chunk;
  // RPC writes one complete JSONL event per write. Preserve malformed writes
  // verbatim so the parent remains the protocol-failure authority.
  let event;
  try {
    event = JSON.parse(chunk);
  } catch (error) {
    if (error instanceof SyntaxError) return chunk;
    throw error;
  }
  if (!event || typeof event !== "object" || typeof event.type !== "string") return chunk;
  return `${JSON.stringify(projectRpcEvent(event))}\n`;
}

export function installRpcStdoutProjection(stream) {
  const originalWrite = stream.write;
  stream.write = function (chunk, encodingOrCallback, callback) {
    return originalWrite.call(this, projectRpcWrite(chunk), encodingOrCallback, callback);
  };
}

// A child inherits NODE_OPTIONS into tools too; never intercept their stdout.
if (process.env.PI_TEAMMATE_CHILD === "1"
  && process.argv.some((arg, index, args) => arg === "--mode" && args[index + 1] === "rpc")) {
  installRpcStdoutProjection(process.stdout);
}
