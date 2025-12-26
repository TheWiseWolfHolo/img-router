import { assert, assertEquals } from "./_assert.ts";
import { decodeBase64, encodeBase64 } from "../base64.ts";
import { parseChatRequestBody } from "../request_parser.ts";
import { extractLastUserPromptAndImages, normalizeChatRequest } from "../normalizer.ts";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X5ZQAAAABJRU5ErkJggg==";

Deno.test("multipart/form-data：payload + image(file) 自动注入到 messages[].content[]", async () => {
  const pngBytes = decodeBase64(ONE_BY_ONE_PNG_BASE64);
  const payloadBody = {
    messages: [{ role: "user", content: "把它变成水彩" }],
  };

  const fd = new FormData();
  fd.set("payload", JSON.stringify(payloadBody));
  const pngBuf = new ArrayBuffer(pngBytes.byteLength);
  new Uint8Array(pngBuf).set(pngBytes);
  fd.set("image", new File([pngBuf], "a.png", { type: "image/png" }));

  const req = new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    body: fd,
  });

  const parsed = await parseChatRequestBody(req);
  assertEquals(parsed.injectedImageCount, 1);

  const normalized = normalizeChatRequest(parsed.body);
  const { prompt, images } = extractLastUserPromptAndImages(normalized.messages);
  assertEquals(prompt, "把它变成水彩");
  assertEquals(images.length, 1);
  assert(images[0]!.startsWith("data:image/png;base64,"));
  assertEquals(images[0]!, `data:image/png;base64,${encodeBase64(pngBytes)}`);
});


