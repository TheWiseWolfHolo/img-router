import { resolveImage, type ResolveImageOptions } from "./image_resolver.ts";

export type ImageInputMode = "passthrough" | "fetch_to_base64";
export type ImageBase64Format = "data_url" | "raw_base64";

export interface PrepareImagesOptions extends ResolveImageOptions {
  mode: ImageInputMode;
  base64Format?: ImageBase64Format;
}

export function parseImageInputMode(value: string | undefined, fallback: ImageInputMode): ImageInputMode {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "passthrough") return "passthrough";
  if (v === "fetch_to_base64") return "fetch_to_base64";
  return fallback;
}

export function parseImageBase64Format(
  value: string | undefined,
  fallback: ImageBase64Format,
): ImageBase64Format {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "data_url") return "data_url";
  if (v === "raw_base64") return "raw_base64";
  return fallback;
}

export async function prepareImagesForUpstream(
  imageUrls: string[],
  options: PrepareImagesOptions,
): Promise<string[]> {
  const mode = options.mode;
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return [];

  if (mode === "passthrough") {
    return imageUrls.filter((u) => typeof u === "string" && u.trim() !== "");
  }

  const base64Format = options.base64Format ?? "data_url";
  const out: string[] = [];
  for (const url of imageUrls) {
    if (typeof url !== "string" || url.trim() === "") continue;
    const resolved = await resolveImage(url, options);
    out.push(base64Format === "raw_base64" ? resolved.base64 : resolved.dataUrl);
  }
  return out;
}


