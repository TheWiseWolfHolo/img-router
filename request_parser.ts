import { encodeBase64 } from "./base64.ts";
import { injectImagesIntoLastUserMessage } from "./normalizer.ts";

export interface ParseBodyResult {
  body: unknown;
  injectedImageCount: number;
  warnings: string[];
}

function normalizeMime(mime: string | undefined): string {
  const v = (mime ?? "").trim().toLowerCase();
  const semi = v.indexOf(";");
  return (semi >= 0 ? v.slice(0, semi) : v);
}

function parseIntEnvLike(v: string | undefined, fallback: number): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function parseChatRequestBody(req: Request): Promise<ParseBodyResult> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();

  if (contentType.includes("multipart/form-data")) {
    return await parseMultipartChatRequest(req);
  }

  const body = await req.json();
  return { body, injectedImageCount: 0, warnings: [] };
}

async function fileToDataUrl(file: File, maxBytes: number): Promise<string> {
  const mime = normalizeMime(file.type);
  if (!mime.startsWith("image/")) {
    throw new Error(`Invalid uploaded file type: ${file.type || "unknown"}`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Uploaded image too large: ${bytes.byteLength} > ${maxBytes}`);
  }
  const b64 = encodeBase64(bytes);
  return `data:${mime};base64,${b64}`;
}

async function parseMultipartChatRequest(req: Request): Promise<ParseBodyResult> {
  const warnings: string[] = [];
  const form = await req.formData();

  const payload =
    (typeof form.get("payload") === "string" ? (form.get("payload") as string) : undefined) ??
    (typeof form.get("json") === "string" ? (form.get("json") as string) : undefined) ??
    (typeof form.get("request") === "string" ? (form.get("request") as string) : undefined);

  if (!payload) {
    throw new Error("multipart/form-data missing payload field (JSON string)");
  }

  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    throw new Error("Invalid multipart payload: not valid JSON");
  }

  const maxBytes = parseIntEnvLike(Deno.env.get("MAX_IMAGE_BYTES"), 10 * 1024 * 1024);

  const dataUrls: string[] = [];
  for (const [key, value] of form.entries()) {
    if (!(value instanceof File)) continue;
    const lower = key.toLowerCase();
    const maybeImageField =
      lower === "file" || lower === "image" || lower === "images" || lower === "files" ||
      lower.endsWith("file") || lower.endsWith("image") || lower.endsWith("images") ||
      lower.endsWith("[]");
    if (!maybeImageField && !normalizeMime(value.type).startsWith("image/")) continue;

    const dataUrl = await fileToDataUrl(value, maxBytes);
    dataUrls.push(dataUrl);
  }

  if (dataUrls.length === 0) {
    warnings.push("multipart/form-data has no image files; payload will be used as-is");
    return { body, injectedImageCount: 0, warnings };
  }

  const injected = injectImagesIntoLastUserMessage(body, dataUrls);
  return { body: injected, injectedImageCount: dataUrls.length, warnings };
}


