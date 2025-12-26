import { assert, assertEquals } from "./_assert.ts";
import { decodeBase64, encodeBase64 } from "../base64.ts";
import { extractLastUserPromptAndImages, normalizeChatRequest } from "../normalizer.ts";
import { prepareImagesForUpstream } from "../image_input.ts";
import { resolveImage } from "../image_resolver.ts";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X5ZQAAAABJRU5ErkJggg==";

Deno.test("content=array + image_url.url=https（服务端拉取转 base64/dataURL）", async () => {
  const body = {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "转换为水彩画风格" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ],
    }],
  };

  const normalized = normalizeChatRequest(body);
  const { prompt, images } = extractLastUserPromptAndImages(normalized.messages);
  assertEquals(prompt, "转换为水彩画风格");
  assertEquals(images, ["https://example.com/a.png"]);

  const pngBytes = decodeBase64(ONE_BY_ONE_PNG_BASE64);
  const pngBuf = new ArrayBuffer(pngBytes.byteLength);
  new Uint8Array(pngBuf).set(pngBytes);

  const mockFetch: typeof fetch = async (input) => {
    const u = String(input);
    assert(u.includes("https://example.com/a.png"));
    return new Response(pngBuf, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(pngBytes.byteLength),
      },
    });
  };

  const upstreamImages = await prepareImagesForUpstream(images, {
    mode: "fetch_to_base64",
    base64Format: "data_url",
    timeoutMs: 1000,
    maxBytes: 1024 * 1024,
    fetchFn: mockFetch,
  });

  assertEquals(upstreamImages.length, 1);
  assert(upstreamImages[0]!.startsWith("data:image/png;base64,"));
  assertEquals(upstreamImages[0]!, `data:image/png;base64,${encodeBase64(pngBytes)}`);
});

Deno.test("content=array + image_url.url=dataURL（直接解析）", async () => {
  const pngBytes = decodeBase64(ONE_BY_ONE_PNG_BASE64);
  const dataUrl = `data:image/png;base64,${encodeBase64(pngBytes)}`;

  const body = {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "做成像素风" },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    }],
  };

  const normalized = normalizeChatRequest(body);
  const { images } = extractLastUserPromptAndImages(normalized.messages);
  assertEquals(images.length, 1);

  const resolved = await resolveImage(images[0]!, { maxBytes: 1024 * 1024 });
  assertEquals(resolved.mime, "image/png");
  assertEquals(resolved.size, pngBytes.byteLength);
  assertEquals(resolved.dataUrl, dataUrl);
});


