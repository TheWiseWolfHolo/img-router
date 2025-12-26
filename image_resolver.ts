import { decodeBase64, encodeBase64 } from "./base64.ts";

export interface ResolveImageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * 是否允许拉取 localhost/内网地址（默认 false）
   * - 仅建议在受控内网环境或测试环境开启
   */
  allowPrivateNetwork?: boolean;
  /**
   * 依赖注入：便于测试 mock
   */
  fetchFn?: typeof fetch;
}

export interface ResolvedImage {
  url: string;
  mime: string;
  bytes: Uint8Array;
  base64: string;
  dataUrl: string;
  size: number;
}

export function isDataUrl(url: string): boolean {
  return url.startsWith("data:");
}

function normalizeMime(mime: string | null | undefined): string | undefined {
  if (!mime) return undefined;
  const semi = mime.indexOf(";");
  return (semi >= 0 ? mime.slice(0, semi) : mime).trim().toLowerCase();
}

function isLikelyIpV4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function parseIpv4(host: string): number[] | null {
  if (!isLikelyIpV4(host)) return null;
  const parts = host.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4) return null;
  for (const n of parts) {
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
  }
  return parts;
}

function isPrivateIp(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0") return true;
  if (h === "::1") return true;

  const ipv4 = parseIpv4(h);
  if (ipv4) {
    const [a, b] = ipv4;
    // 127.0.0.0/8
    if (a === 127) return true;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
    return false;
  }

  // IPv6 基本判断（不做 DNS 解析，仅处理明显内网段）
  if (h.includes(":")) {
    const noZone = h.split("%")[0] ?? h;
    if (noZone === "::1") return true;
    // fc00::/7 (ULA)
    if (noZone.startsWith("fc") || noZone.startsWith("fd")) return true;
    // fe80::/10 (link-local)
    if (noZone.startsWith("fe80:") || noZone.startsWith("fe80::")) return true;
  }

  return false;
}

function assertAllowedRemoteUrl(u: URL, allowPrivateNetwork: boolean): void {
  const protocol = u.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`Unsupported image URL protocol: ${u.protocol}`);
  }
  if (!allowPrivateNetwork && isPrivateIp(u.hostname)) {
    throw new Error("Blocked by SSRF protection: private/localhost address is not allowed");
  }
}

function parseDataUrlToBytes(dataUrl: string): { mime: string; bytes: Uint8Array } {
  // data:[<mime>][;base64],<data>
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Invalid data URL: missing comma");

  const meta = dataUrl.slice(5, comma);
  const data = dataUrl.slice(comma + 1);

  const metaParts = meta.split(";");
  const mime = normalizeMime(metaParts[0] || "") || "application/octet-stream";
  const isBase64 = metaParts.map((p) => p.trim().toLowerCase()).includes("base64");
  if (!isBase64) {
    throw new Error("Invalid data URL: only base64-encoded data URLs are supported");
  }
  if (!mime.startsWith("image/")) {
    throw new Error(`Invalid data URL mime: ${mime}`);
  }

  const bytes = decodeBase64(data);
  return { mime, bytes };
}

async function readResponseBytesWithLimit(resp: Response, maxBytes: number): Promise<Uint8Array> {
  const lenHeader = resp.headers.get("content-length");
  if (lenHeader) {
    const declared = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`Image too large: content-length ${declared} > ${maxBytes}`);
    }
  }

  if (!resp.body) {
    return new Uint8Array(0);
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        throw new Error(`Image too large: exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function resolveImage(url: string, options: ResolveImageOptions = {}): Promise<ResolvedImage> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const allowPrivateNetwork = options.allowPrivateNetwork ?? false;
  const fetchFn = options.fetchFn ?? fetch;

  if (typeof url !== "string" || url.trim() === "") {
    throw new Error("Invalid image url: empty");
  }

  if (isDataUrl(url)) {
    const { mime, bytes } = parseDataUrlToBytes(url);
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Image too large: ${bytes.byteLength} > ${maxBytes}`);
    }
    const base64 = encodeBase64(bytes);
    const dataUrl = `data:${mime};base64,${base64}`;
    return { url, mime, bytes, base64, dataUrl, size: bytes.byteLength };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid image url: not a valid URL");
  }

  assertAllowedRemoteUrl(parsed, allowPrivateNetwork);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetchFn(parsed.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "Accept": "image/*",
      },
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Failed to fetch image (${resp.status}): ${text}`);
    }

    const ct = normalizeMime(resp.headers.get("content-type"));
    if (!ct || !ct.startsWith("image/")) {
      throw new Error(`Invalid Content-Type: ${resp.headers.get("content-type") ?? "unknown"}`);
    }

    const bytes = await readResponseBytesWithLimit(resp, maxBytes);
    const base64 = encodeBase64(bytes);
    const dataUrl = `data:${ct};base64,${base64}`;
    return { url, mime: ct, bytes, base64, dataUrl, size: bytes.byteLength };
  } finally {
    clearTimeout(timeoutId);
  }
}


