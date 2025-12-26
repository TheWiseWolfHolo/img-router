// 三合一图像生成 API 中转服务
// 支持：火山引擎 (VolcEngine)、Gitee (模力方舟)、ModelScope (魔塔)
// 路由策略：根据 API Key 格式自动分发

// ================= 导入日志模块 =================

import {
  configureLogger,
  initLogger,
  closeLogger,
  logRequestStart,
  logRequestEnd,
  logProviderRouting,
  logApiCallStart,
  logApiCallEnd,
  generateRequestId,
  info,
  warn,
  error,
  debug,
  LogLevel,
  // 增强日志函数
  logFullPrompt,
  logInputImages,
  logImageGenerationStart,
  logGeneratedImages,
  logImageGenerationComplete,
  logImageGenerationFailed,
} from "./logger.ts";

// ================= 配置常量 =================

import {
  VolcEngineConfig,
  GiteeConfig,
  ModelScopeConfig,
  API_TIMEOUT_MS,
  PORT,
} from "./config.ts";

import {
  normalizeChatRequest,
  extractLastUserPromptAndImages,
  type NormalizedChatRequest,
} from "./normalizer.ts";

import { parseChatRequestBody } from "./request_parser.ts";

import {
  prepareImagesForUpstream,
  parseImageInputMode,
  parseImageBase64Format,
  type ImageBase64Format,
  type ImageInputMode,
} from "./image_input.ts";

import { resolveImage } from "./image_resolver.ts";

// ================= 类型定义 =================

type Provider = "VolcEngine" | "Gitee" | "ModelScope" | "Unknown";

// ================= 核心逻辑 =================

function detectProvider(apiKey: string): Provider {
  if (!apiKey) return "Unknown";

  if (apiKey.startsWith("ms-")) {
    logProviderRouting("ModelScope", apiKey.substring(0, 4));
    return "ModelScope";
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(apiKey)) {
    logProviderRouting("VolcEngine", apiKey.substring(0, 4));
    return "VolcEngine";
  }

  const giteeRegex = /^[a-zA-Z0-9]{30,60}$/;
  if (giteeRegex.test(apiKey)) {
    logProviderRouting("Gitee", apiKey.substring(0, 4));
    return "Gitee";
  }

  logProviderRouting("Unknown", apiKey.substring(0, 4));
  return "Unknown";
}

function getEnvInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function getEnvBool(name: string, fallback: boolean): boolean {
  const raw = (Deno.env.get(name) ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return fallback;
}

function enforceSupportedModels(): boolean {
  // 默认不强制（允许透传任意 model，避免出现“被强制路由到默认模型”的问题）
  return getEnvBool("ENFORCE_SUPPORTED_MODELS", false);
}

function getProviderImageInputMode(provider: Provider): ImageInputMode {
  const globalMode = parseImageInputMode(Deno.env.get("IMAGE_INPUT_MODE"), "fetch_to_base64");
  const perProviderKey = provider === "VolcEngine"
    ? "VOLCENGINE_IMAGE_INPUT_MODE"
    : provider === "Gitee"
    ? "GITEE_IMAGE_INPUT_MODE"
    : provider === "ModelScope"
    ? "MODELSCOPE_IMAGE_INPUT_MODE"
    : undefined;

  const per = perProviderKey ? Deno.env.get(perProviderKey) : undefined;
  return parseImageInputMode(per, globalMode);
}

function getProviderImageBase64Format(provider: Provider): ImageBase64Format {
  const globalFmt = parseImageBase64Format(Deno.env.get("IMAGE_BASE64_FORMAT"), "data_url");
  const perProviderKey = provider === "VolcEngine"
    ? "VOLCENGINE_IMAGE_BASE64_FORMAT"
    : provider === "Gitee"
    ? "GITEE_IMAGE_BASE64_FORMAT"
    : provider === "ModelScope"
    ? "MODELSCOPE_IMAGE_BASE64_FORMAT"
    : undefined;

  const per = perProviderKey ? Deno.env.get(perProviderKey) : undefined;
  return parseImageBase64Format(per, globalFmt);
}

// ================= 超时控制辅助函数 =================

/**
 * 带超时控制的 fetch 函数
 * @param url 请求 URL
 * @param options fetch 选项
 * @param timeoutMs 超时时间（毫秒），默认使用 API_TIMEOUT_MS
 * @returns Promise<Response>
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = API_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ================= 渠道处理函数 =================

async function handleVolcEngine(
  apiKey: string,
  reqBody: NormalizedChatRequest,
  prompt: string,
  images: string[],
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  logApiCallStart("VolcEngine", "generate_image");
  
  // 记录完整 Prompt
  logFullPrompt("VolcEngine", requestId, prompt);
  
  // 记录输入图片
  logInputImages("VolcEngine", requestId, images);
  
  // 使用配置中的默认模型，支持多模型
  const requestedModel = reqBody.model?.trim();
  const model = requestedModel
    ? (!enforceSupportedModels() || VolcEngineConfig.supportedModels.includes(requestedModel)
      ? requestedModel
      : (warn(
        "VolcEngine",
        `请求模型不在 supportedModels 中，已回退默认模型: ${requestedModel} -> ${VolcEngineConfig.defaultModel}（如需透传任意模型请设置 ENFORCE_SUPPORTED_MODELS=false）`,
      ), VolcEngineConfig.defaultModel))
    : VolcEngineConfig.defaultModel;
  const size = reqBody.size || "4096x4096";
  
  // 记录生成开始
  logImageGenerationStart("VolcEngine", requestId, model, size, prompt.length);
  
  const arkRequest = {
    model: model,
    prompt: prompt || "A beautiful scenery",
    image: images,
    response_format: "url",
    size: size,
    seed: -1,
    stream: false,
    watermark: false,
  };

  const response = await fetchWithTimeout(VolcEngineConfig.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "Connection": "close"
    },
    body: JSON.stringify(arkRequest),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const err = new Error(`VolcEngine API Error (${response.status}): ${errorText}`);
    logImageGenerationFailed("VolcEngine", requestId, errorText);
    logApiCallEnd("VolcEngine", "generate_image", false, Date.now() - startTime);
    throw err;
  }

  const data = await response.json();
  
  // 记录生成的图片 URL
  logGeneratedImages("VolcEngine", requestId, data.data || []);
  
  const duration = Date.now() - startTime;
  const imageCount = data.data?.length || 0;
  logImageGenerationComplete("VolcEngine", requestId, imageCount, duration);
  
  const result = data.data?.map((img: { url: string }) => `![Generated Image](${img.url})`).join("\n\n") || "图片生成失败";
  
  logApiCallEnd("VolcEngine", "generate_image", true, duration);
  return result;
}

async function handleGitee(
  apiKey: string,
  reqBody: NormalizedChatRequest,
  prompt: string,
  images: string[],
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  logApiCallStart("Gitee", "generate_image");

  // 记录完整 Prompt
  logFullPrompt("Gitee", requestId, prompt);

  // 记录输入图片（图生图）
  logInputImages("Gitee", requestId, images);
  
  // 使用配置中的默认模型，支持多模型
  const requestedModel = reqBody.model?.trim();
  const model = requestedModel
    ? (!enforceSupportedModels() || GiteeConfig.supportedModels.includes(requestedModel)
      ? requestedModel
      : (warn(
        "Gitee",
        `请求模型不在 supportedModels 中，已回退默认模型: ${requestedModel} -> ${GiteeConfig.defaultModel}（如需透传任意模型请设置 ENFORCE_SUPPORTED_MODELS=false）`,
      ), GiteeConfig.defaultModel))
    : GiteeConfig.defaultModel;
  const size = reqBody.size || "2048x2048";
  
  // 记录生成开始
  logImageGenerationStart("Gitee", requestId, model, size, prompt.length);

  const giteeRequest = {
    model: model,
    prompt: prompt || "A beautiful scenery",
    // 图生图/编辑：尽量按 OpenAI 兼容扩展字段传递（不同上游可能字段名不同，但通常会忽略未知字段）
    ...(images.length > 0 ? { image: images[0] } : {}),
    size: size,
    n: 1,
    response_format: "url"
  };

  debug("Gitee", `发送请求到: ${GiteeConfig.apiUrl}`);

  const response = await fetchWithTimeout(GiteeConfig.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "User-Agent": "ImgRouter/1.0"
    },
    body: JSON.stringify(giteeRequest),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const err = new Error(`Gitee API Error (${response.status}): ${errorText}`);
    error("Gitee", `API 错误: ${response.status}`);
    logImageGenerationFailed("Gitee", requestId, errorText);
    logApiCallEnd("Gitee", "generate_image", false, Date.now() - startTime);
    throw err;
  }

  const responseText = await response.text();
  const data = JSON.parse(responseText);

  if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
    const err = new Error(`Gitee API 返回数据格式异常: ${JSON.stringify(data)}`);
    error("Gitee", "返回数据格式异常");
    logImageGenerationFailed("Gitee", requestId, "返回数据格式异常");
    logApiCallEnd("Gitee", "generate_image", false, Date.now() - startTime);
    throw err;
  }

  // 记录生成的图片 URL
  logGeneratedImages("Gitee", requestId, data.data);
  
  const duration = Date.now() - startTime;
  const imageCount = data.data.length;
  logImageGenerationComplete("Gitee", requestId, imageCount, duration);

  const imageUrls = data.data.map((img: { url?: string; b64_json?: string }) => {
    if (img.url) {
      return `![Generated Image](${img.url})`;
    } else if (img.b64_json) {
      return `![Generated Image](data:image/png;base64,${img.b64_json})`;
    }
    return "";
  }).filter(Boolean);

  const result = imageUrls.join("\n\n");
  logApiCallEnd("Gitee", "generate_image", true, duration);
  return result || "图片生成失败";
}

async function handleModelScope(
  apiKey: string,
  reqBody: NormalizedChatRequest,
  prompt: string,
  images: string[],
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  logApiCallStart("ModelScope", "generate_image");

  // 记录完整 Prompt
  logFullPrompt("ModelScope", requestId, prompt);

  // 记录输入图片（图生图）
  logInputImages("ModelScope", requestId, images);
  
  // 使用配置中的默认模型，支持多模型
  const requestedModel = reqBody.model?.trim();
  const model = requestedModel
    ? (!enforceSupportedModels() || ModelScopeConfig.supportedModels.includes(requestedModel)
      ? requestedModel
      : (warn(
        "ModelScope",
        `请求模型不在 supportedModels 中，已回退默认模型: ${requestedModel} -> ${ModelScopeConfig.defaultModel}（如需透传任意模型请设置 ENFORCE_SUPPORTED_MODELS=false）`,
      ), ModelScopeConfig.defaultModel))
    : ModelScopeConfig.defaultModel;
  const size = reqBody.size || "2048x2048";
  
  // 记录生成开始
  logImageGenerationStart("ModelScope", requestId, model, size, prompt.length);

  const isImageEditModel = model.toLowerCase().includes("image-edit");

  const extractImages = (payload: any): { url?: string; b64_json?: string }[] => {
    const out: { url?: string; b64_json?: string }[] = [];

    const pushAny = (v: any): void => {
      if (!v) return;
      if (typeof v === "string") {
        if (v.startsWith("data:")) out.push({ b64_json: v });
        else out.push({ url: v });
        return;
      }
      if (typeof v === "object") {
        const url = typeof v.url === "string" ? v.url : undefined;
        const b64 =
          typeof v.b64_json === "string" ? v.b64_json
            : (typeof v.base64 === "string" ? v.base64 : undefined);
        if (url || b64) out.push({ url, b64_json: b64 });
      }
    };

    const tryArray = (arr: any): void => {
      if (!Array.isArray(arr)) return;
      for (const it of arr) pushAny(it);
    };

    tryArray(payload?.output_images);
    tryArray(payload?.output?.output_images);
    tryArray(payload?.output?.images);
    tryArray(payload?.output_images);
    tryArray(payload?.images);
    tryArray(payload?.data);

    pushAny(payload?.output_image);
    pushAny(payload?.output?.output_image);
    pushAny(payload?.output?.image);

    return out.filter((x) => (typeof x.url === "string" && x.url.trim() !== "") ||
      (typeof x.b64_json === "string" && x.b64_json.trim() !== ""));
  };

  const imageFetchTimeoutMs = getEnvInt("IMAGE_FETCH_TIMEOUT_MS", 10_000);
  const maxImageBytes = getEnvInt("MAX_IMAGE_BYTES", 10 * 1024 * 1024);
  const allowPrivateImageFetch = getEnvBool("ALLOW_PRIVATE_IMAGE_FETCH", false);

  const submitUrl = isImageEditModel
    ? `${ModelScopeConfig.apiUrl}/images/edits`
    : `${ModelScopeConfig.apiUrl}/images/generations`;

  const submitHeaders: Record<string, string> = {
    "Authorization": `Bearer ${apiKey}`,
    "X-ModelScope-Async-Mode": "true",
  };

  let submitResponse: Response;
  if (isImageEditModel) {
    if (images.length === 0) {
      throw new Error("ModelScope image edit requires a reference image, but none was provided");
    }

    const resolved = await resolveImage(images[0]!, {
      timeoutMs: imageFetchTimeoutMs,
      maxBytes: maxImageBytes,
      allowPrivateNetwork: allowPrivateImageFetch,
    });

    const guessExt = (mime: string): string => {
      if (mime === "image/png") return "png";
      if (mime === "image/jpeg") return "jpg";
      if (mime === "image/webp") return "webp";
      if (mime === "image/gif") return "gif";
      return "png";
    };

    // 这里手动拷贝到 ArrayBuffer，避免 TS 类型把 buffer 推断成 SharedArrayBuffer
    const ab = new ArrayBuffer(resolved.bytes.byteLength);
    new Uint8Array(ab).set(resolved.bytes);
    const blob = new Blob([ab], { type: resolved.mime });

    const imageField = (Deno.env.get("MODELSCOPE_IMAGE_UPLOAD_FIELD") ?? "image").trim() || "image";
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", prompt || "A beautiful scenery");
    form.set("n", "1");
    form.set("size", size);
    form.set("response_format", "url");
    form.set(imageField, blob, `image.${guessExt(resolved.mime)}`);

    submitResponse = await fetchWithTimeout(submitUrl, {
      method: "POST",
      headers: submitHeaders,
      body: form,
    });
  } else {
    submitResponse = await fetchWithTimeout(submitUrl, {
      method: "POST",
      headers: {
        ...submitHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model,
        prompt: prompt || "A beautiful scenery",
        ...(images.length > 0 ? { image: images[0] } : {}),
        response_format: "url",
        size: size,
        n: 1,
      }),
    });
  }

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    const err = new Error(`ModelScope Submit Error (${submitResponse.status}): ${errorText}`);
    logImageGenerationFailed("ModelScope", requestId, errorText);
    logApiCallEnd("ModelScope", "generate_image", false, Date.now() - startTime);
    throw err;
  }

  const submitData = await submitResponse.json();

  // 兼容：如果不返回 task_id（同步返回），直接尝试解析图片
  const taskId = submitData.task_id;
  if (!taskId) {
    const imageData = extractImages(submitData);
    if (imageData.length > 0) {
      logGeneratedImages("ModelScope", requestId, imageData);
      const result = imageData.map((img) => {
        if (img.url) return `![Generated Image](${img.url})`;
        if (img.b64_json) {
          const v = img.b64_json.startsWith("data:")
            ? img.b64_json
            : `data:image/png;base64,${img.b64_json}`;
          return `![Generated Image](${v})`;
        }
        return "";
      }).filter(Boolean).join("\n\n");
      logApiCallEnd("ModelScope", "generate_image", true, Date.now() - startTime);
      return result || "图片生成失败";
    }
    throw new Error(`ModelScope unexpected response without task_id: ${JSON.stringify(Object.keys(submitData ?? {}))}`);
  }

  info("ModelScope", `任务已提交, Task ID: ${taskId}`);

  const maxAttempts = 60;
  let pollingAttempts = 0;
  
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    pollingAttempts++;

    const configuredTaskType = (Deno.env.get("MODELSCOPE_TASK_TYPE") ?? "image_generation").trim();
    const baseHeaders: Record<string, string> = {
      "Authorization": `Bearer ${apiKey}`,
    };
    const headersWithType = configuredTaskType
      ? { ...baseHeaders, "X-ModelScope-Task-Type": configuredTaskType }
      : baseHeaders;

    // 有些场景 task_type 可能不需要/不匹配：失败时自动降级为不带该头再试一次
    let checkResponse = await fetchWithTimeout(`${ModelScopeConfig.apiUrl}/tasks/${taskId}`, {
      method: "GET",
      headers: headersWithType,
    });
    if (!checkResponse.ok && configuredTaskType) {
      checkResponse = await fetchWithTimeout(`${ModelScopeConfig.apiUrl}/tasks/${taskId}`, {
        method: "GET",
        headers: baseHeaders,
      });
    }

    if (!checkResponse.ok) {
      warn("ModelScope", `轮询警告: ${checkResponse.status}`);
      continue;
    }

    const checkData = await checkResponse.json();
    const status = checkData.task_status;

    if (status === "SUCCEED") {
      const imageData = extractImages(checkData);

      if (imageData.length === 0) {
        // 帮助排查：仅打印 key，不打印完整 payload（避免日志爆炸）
        const keys = Object.keys(checkData ?? {}).slice(0, 30);
        warn(
          "ModelScope",
          `任务 SUCCEED 但未解析到图片输出，checkData keys=${JSON.stringify(keys)}`,
        );
      }

      logGeneratedImages("ModelScope", requestId, imageData);

      const duration = Date.now() - startTime;
      const imageCount = imageData.length;
      logImageGenerationComplete("ModelScope", requestId, imageCount, duration);

      const toMarkdown = (img: { url?: string; b64_json?: string }): string => {
        if (img.url) return `![Generated Image](${img.url})`;
        if (img.b64_json) {
          const v = img.b64_json.startsWith("data:")
            ? img.b64_json
            : `data:image/png;base64,${img.b64_json}`;
          return `![Generated Image](${v})`;
        }
        return "";
      };

      const result = imageData.map(toMarkdown).filter(Boolean).join("\n\n") || "图片生成失败";

      info("ModelScope", `任务成功完成, 耗时: ${pollingAttempts}次轮询`);
      logApiCallEnd("ModelScope", "generate_image", true, duration);
      return result;
    } else if (status === "FAILED") {
      const err = new Error(`ModelScope Task Failed: ${JSON.stringify(checkData)}`);
      error("ModelScope", "任务失败");
      logImageGenerationFailed("ModelScope", requestId, JSON.stringify(checkData));
      logApiCallEnd("ModelScope", "generate_image", false, Date.now() - startTime);
      throw err;
    } else {
      debug("ModelScope", `状态: ${status} (第${i + 1}次)`);
    }
  }

  const err = new Error("ModelScope Task Timeout");
  error("ModelScope", "任务超时");
  logImageGenerationFailed("ModelScope", requestId, "任务超时");
  logApiCallEnd("ModelScope", "generate_image", false, Date.now() - startTime);
  throw err;
}

// ================= 主处理函数 =================

async function handleChatCompletions(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = generateRequestId();

  logRequestStart(req, requestId);

  if (url.pathname !== "/v1/chat/completions") {
    warn("HTTP", `路由不匹配: ${url.pathname}`);
    await logRequestEnd(requestId, req.method, url.pathname, 404, 0);
    return new Response(JSON.stringify({ error: "Not found" }), { 
      status: 404, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  const authHeader = req.headers.get("Authorization");
  const apiKey = authHeader?.replace("Bearer ", "").trim();
  
  if (!apiKey) {
    warn("HTTP", "Authorization header 缺失");
    await logRequestEnd(requestId, req.method, url.pathname, 401, 0, "missing auth");
    return new Response(JSON.stringify({ error: "Authorization header missing" }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  const provider = detectProvider(apiKey);
  if (provider === "Unknown") {
    warn("HTTP", "API Key 格式无法识别");
    await logRequestEnd(requestId, req.method, url.pathname, 401, 0, "invalid key");
    return new Response(JSON.stringify({ error: "Invalid API Key format. Could not detect provider." }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  info("HTTP", `路由到 ${provider}`);

  try {
    const parsed = await parseChatRequestBody(req);
    if (parsed.warnings.length > 0) {
      for (const w of parsed.warnings) warn("HTTP", `${requestId} multipart warning: ${w}`);
    }
    if (parsed.injectedImageCount > 0) {
      info("HTTP", `${requestId} multipart 注入图片数量: ${parsed.injectedImageCount}`);
    }

    const requestBody = normalizeChatRequest(parsed.body);
    const isStream = requestBody.stream === true;
    const { prompt, images } = extractLastUserPromptAndImages(requestBody.messages || []);

    const imageMode = getProviderImageInputMode(provider);
    const base64Format = getProviderImageBase64Format(provider);
    const imageFetchTimeoutMs = getEnvInt("IMAGE_FETCH_TIMEOUT_MS", 10_000);
    const maxImageBytes = getEnvInt("MAX_IMAGE_BYTES", 10 * 1024 * 1024);
    const allowPrivateImageFetch = getEnvBool("ALLOW_PRIVATE_IMAGE_FETCH", false);

    const upstreamImages = await prepareImagesForUpstream(images, {
      mode: imageMode,
      base64Format,
      timeoutMs: imageFetchTimeoutMs,
      maxBytes: maxImageBytes,
      allowPrivateNetwork: allowPrivateImageFetch,
    });

    // 记录完整 Prompt（DEBUG 级别只记录摘要）
    debug("Router", `提取 Prompt: ${prompt?.substring(0, 80)}... (完整长度: ${prompt?.length || 0})`);

    let imageContent = "";
    
    switch (provider) {
      case "VolcEngine":
        imageContent = await handleVolcEngine(apiKey, requestBody, prompt, upstreamImages, requestId);
        break;
      case "Gitee":
        imageContent = await handleGitee(apiKey, requestBody, prompt, upstreamImages, requestId);
        break;
      case "ModelScope":
        imageContent = await handleModelScope(apiKey, requestBody, prompt, upstreamImages, requestId);
        break;
    }

    const responseId = `chatcmpl-${crypto.randomUUID()}`;
    const modelName = requestBody.model || "unknown-model";
    const startTime = Date.now();

    if (isStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const contentChunk = {
            id: responseId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{
              index: 0,
              delta: { role: "assistant", content: imageContent },
              finish_reason: null
            }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));

          const endChunk = {
            id: responseId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "stop"
            }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        }
      });

      info("HTTP", `响应完成 (流式)`);
      await logRequestEnd(requestId, req.method, url.pathname, 200, Date.now() - startTime);
      
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        }
      });
    }

    const responseBody = JSON.stringify({
      id: responseId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [{
        index: 0,
        message: { role: "assistant", content: imageContent },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });

    info("HTTP", `响应完成 (JSON)`);
    await logRequestEnd(requestId, req.method, url.pathname, 200, Date.now() - startTime);

    return new Response(responseBody, {
      headers: { 
        "Content-Type": "application/json", 
        "Access-Control-Allow-Origin": "*" 
      }
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Internal Server Error";
    const errorProvider = provider || "Unknown";
    
    error("Proxy", `请求处理错误 (${errorProvider}): ${errorMessage}`);
    await logRequestEnd(requestId, req.method, url.pathname, 500, 0, errorMessage);
    
    return new Response(JSON.stringify({ 
      error: { message: errorMessage, type: "server_error", provider: errorProvider } 
    }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    });
  }
}

// ================= 启动服务 =================

await initLogger();

const logLevel = Deno.env.get("LOG_LEVEL")?.toUpperCase();
if (logLevel && logLevel in LogLevel) {
  configureLogger({ level: LogLevel[logLevel as keyof typeof LogLevel] });
}

info("Startup", `🚀 服务启动端口 ${PORT}`);
info("Startup", "🔧 支持: 火山引擎, Gitee, ModelScope");
info("Startup", `📁 日志目录: ./data/logs`);

Deno.addSignalListener("SIGINT", async () => {
  info("Startup", "收到 SIGINT, 关闭服务...");
  await closeLogger();
  Deno.exit(0);
});

Deno.addSignalListener("SIGTERM", async () => {
  info("Startup", "收到 SIGTERM, 关闭服务...");
  await closeLogger();
  Deno.exit(0);
});

Deno.serve({ port: PORT }, (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
    return new Response("ok", {
      headers: {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      }
    });
  }

  if (req.method !== "POST") {
    warn("HTTP", `不支持 ${req.method}`);
    return new Response("Method Not Allowed", { status: 405 });
  }

  return handleChatCompletions(req);
});
