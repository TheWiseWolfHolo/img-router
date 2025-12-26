import { assertEquals } from "./_assert.ts";
import { extractLastUserPromptAndImages, normalizeChatRequest } from "../normalizer.ts";

Deno.test("content=string（纯文生图）", () => {
  const body = {
    model: "any-model",
    messages: [{ role: "user", content: "一只可爱的猫咪" }],
    size: "1024x1024",
  };

  const normalized = normalizeChatRequest(body);
  const { prompt, images } = extractLastUserPromptAndImages(normalized.messages);

  assertEquals(prompt, "一只可爱的猫咪");
  assertEquals(images, []);
});


