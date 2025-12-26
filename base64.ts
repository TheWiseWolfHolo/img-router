// Base64 编解码工具（避免引入额外依赖，适用于中等体积二进制数据）

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(256);
  table.fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  // 支持 base64url
  table["-".charCodeAt(0)] = 62;
  table["_".charCodeAt(0)] = 63;
  return table;
})();

export function encodeBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const outLen = Math.ceil(bytes.length / 3) * 4;
  const out = new Array<string>(outLen);

  let o = 0;
  let i = 0;

  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | (bytes[i + 2]);
    out[o++] = BASE64_ALPHABET[(n >>> 18) & 63]!;
    out[o++] = BASE64_ALPHABET[(n >>> 12) & 63]!;
    out[o++] = BASE64_ALPHABET[(n >>> 6) & 63]!;
    out[o++] = BASE64_ALPHABET[n & 63]!;
  }

  const remain = bytes.length - i;
  if (remain === 1) {
    const n = bytes[i]!;
    out[o++] = BASE64_ALPHABET[(n >>> 2) & 63]!;
    out[o++] = BASE64_ALPHABET[(n & 3) << 4]!;
    out[o++] = "=";
    out[o++] = "=";
  } else if (remain === 2) {
    const n = (bytes[i]! << 8) | (bytes[i + 1]!);
    out[o++] = BASE64_ALPHABET[(n >>> 10) & 63]!;
    out[o++] = BASE64_ALPHABET[(n >>> 4) & 63]!;
    out[o++] = BASE64_ALPHABET[(n & 15) << 2]!;
    out[o++] = "=";
  }

  return out.join("");
}

export function decodeBase64(input: string): Uint8Array {
  const cleaned = input.replace(/\s+/g, "");
  if (cleaned.length === 0) return new Uint8Array(0);

  // 允许缺 padding
  const mod = cleaned.length % 4;
  const padded = mod === 0 ? cleaned : cleaned + "=".repeat(4 - mod);

  if (padded.length % 4 !== 0) {
    throw new Error("Invalid base64 length");
  }

  const len = padded.length;
  const padding = (padded.endsWith("==") ? 2 : (padded.endsWith("=") ? 1 : 0));
  const outLen = (len / 4) * 3 - padding;
  const out = new Uint8Array(outLen);

  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = padded.charCodeAt(i);
    const c1 = padded.charCodeAt(i + 1);
    const c2 = padded.charCodeAt(i + 2);
    const c3 = padded.charCodeAt(i + 3);

    const v0 = BASE64_LOOKUP[c0]!;
    const v1 = BASE64_LOOKUP[c1]!;
    const v2 = c2 === 61 ? -2 : BASE64_LOOKUP[c2]!;
    const v3 = c3 === 61 ? -2 : BASE64_LOOKUP[c3]!;

    if (v0 < 0 || v1 < 0 || v2 === -1 || v3 === -1) {
      throw new Error("Invalid base64 character");
    }

    const n = (v0 << 18) | (v1 << 12) | ((v2 & 63) << 6) | (v3 & 63);

    out[o++] = (n >>> 16) & 255;
    if (v2 !== -2) out[o++] = (n >>> 8) & 255;
    if (v3 !== -2) out[o++] = n & 255;
  }

  return out;
}


