export type NormalizedPart =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string; detail?: string };

export interface NormalizedMessage {
  role: string;
  parts: NormalizedPart[];
}

export interface NormalizedChatRequest {
  model?: string;
  size?: string;
  stream: boolean;
  messages: NormalizedMessage[];
  // 保留原始字段（便于后续透传/调试）
  extra: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

function extractTextPart(item: unknown): string | undefined {
  if (typeof item === "string") return item;
  if (!isRecord(item)) return undefined;

  const t = asString(item.type);
  if (t === "text" || t === "input_text") {
    const text = asString(item.text);
    if (typeof text === "string") return text;
  }

  // 兼容一些客户端直接发 { content: "..."} 片段
  const text = asString(item.text) ?? asString(item.content);
  if (typeof text === "string" && (t === "text" || t === "input_text")) return text;

  return undefined;
}

function extractImagePart(item: unknown): { url: string; detail?: string } | undefined {
  if (!isRecord(item)) return undefined;
  const t = asString(item.type);

  // 常见图片类型：image_url / input_image / image
  const isImageType = t === "image_url" || t === "input_image" || t === "image";
  if (!isImageType) return undefined;

  // 1) 标准：{ type:"image_url", image_url:{ url, detail? } }
  const imageUrlField = item.image_url;
  if (typeof imageUrlField === "string" && imageUrlField.trim() !== "") {
    return { url: imageUrlField };
  }
  if (isRecord(imageUrlField)) {
    const url = asString(imageUrlField.url);
    const detail = asString(imageUrlField.detail);
    if (typeof url === "string" && url.trim() !== "") {
      return detail ? { url, detail } : { url };
    }
  }

  // 2) 变体：{ type:"input_image", url:"..." }
  const url = asString(item.url) ?? asString(item.image);
  if (typeof url === "string" && url.trim() !== "") {
    return { url };
  }

  // 3) 变体：{ type:"image_url", image_url:{ image_url:"..." } }（少数奇怪客户端）
  if (isRecord(imageUrlField)) {
    const nested = asString(imageUrlField.image_url);
    if (typeof nested === "string" && nested.trim() !== "") {
      return { url: nested };
    }
  }

  return undefined;
}

function normalizeContentToParts(content: unknown): NormalizedPart[] {
  if (typeof content === "string") {
    return content.trim() === "" ? [] : [{ kind: "text", text: content }];
  }

  // 允许 content 是单个对象（当客户端不小心发错形态）
  const arr = Array.isArray(content) ? content : [content];

  const parts: NormalizedPart[] = [];
  for (const item of arr) {
    if (typeof item === "string") {
      if (item.trim() !== "") parts.push({ kind: "text", text: item });
      continue;
    }

    const text = extractTextPart(item);
    if (typeof text === "string" && text.trim() !== "") {
      parts.push({ kind: "text", text });
      continue;
    }

    const image = extractImagePart(item);
    if (image) {
      parts.push({ kind: "image", url: image.url, detail: image.detail });
      continue;
    }

    // 忽略未知片段（但保留兼容性）
  }

  return parts;
}

export function normalizeChatRequest(input: unknown): NormalizedChatRequest {
  if (!isRecord(input)) {
    throw new Error("Invalid request body: expected JSON object");
  }

  const extra: Record<string, unknown> = { ...input };
  const model = asString(input.model);
  const size = asString(input.size);
  const stream = input.stream === true;

  const rawMessages = input.messages;
  if (!Array.isArray(rawMessages)) {
    throw new Error("Invalid request body: messages must be an array");
  }

  const messages: NormalizedMessage[] = rawMessages.map((m) => {
    if (!isRecord(m)) {
      return { role: "user", parts: [] };
    }
    const role = asString(m.role) ?? "user";
    const parts = normalizeContentToParts(m.content);
    return { role, parts };
  });

  return { model, size, stream, messages, extra };
}

export function extractLastUserPromptAndImages(
  messages: NormalizedMessage[],
): { prompt: string; images: string[] } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;
    const texts = msg.parts.filter((p) => p.kind === "text").map((p) => (p as { kind: "text"; text: string }).text);
    const prompt = texts.join("\n").trim();
    const images = msg.parts.filter((p) => p.kind === "image").map((p) => (p as { kind: "image"; url: string }).url).filter((u) => typeof u === "string" && u.trim() !== "");
    return { prompt, images };
  }
  return { prompt: "", images: [] };
}

// 将图片（dataURL）注入到最后一个 user 消息中（multipart 场景使用）
export function injectImagesIntoLastUserMessage(
  body: unknown,
  dataUrls: string[],
): unknown {
  if (!isRecord(body)) return body;
  if (!Array.isArray(body.messages)) return body;
  if (dataUrls.length === 0) return body;

  const messages = body.messages as unknown[];
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isRecord(m) && asString(m.role) === "user") {
      idx = i;
      break;
    }
  }

  if (idx === -1) {
    messages.push({
      role: "user",
      content: dataUrls.map((url) => ({ type: "image_url", image_url: { url } })),
    });
    return body;
  }

  const msg = messages[idx];
  if (!isRecord(msg)) return body;

  const current = msg.content;
  let contentArr: unknown[];
  if (typeof current === "string") {
    contentArr = [{ type: "text", text: current }];
  } else if (Array.isArray(current)) {
    contentArr = [...current];
  } else if (current == null) {
    contentArr = [];
  } else {
    contentArr = [current];
  }

  for (const url of dataUrls) {
    contentArr.push({ type: "image_url", image_url: { url } });
  }

  msg.content = contentArr;
  return body;
}


