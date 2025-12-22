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

const VOLC_API_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const GITEE_API_URL = "https://ai.gitee.com/v1/images/generations";
const GITEE_DEFAULT_MODEL = "z-image-turbo";
const MODELSCOPE_API_URL = "https://api-inference.modelscope.cn/v1";
const MODELSCOPE_DEFAULT_MODEL = "Tongyi-MAI/Z-Image-Turbo";
const PORT = parseInt(Deno.env.get("PORT") || "10001");
// 统一超时时间：120秒（适用于所有渠道的 API 请求）
const API_TIMEOUT_MS = 120000;

// ================= 类型定义 =================

type Provider = "VolcEngine" | "Gitee" | "ModelScope" | "Unknown";

// 消息内容项类型
interface TextContentItem {
  type: "text";
  text: string;
}

interface ImageUrlContentItem {
  type: "image_url";
  image_url?: { url: string };
}

type MessageContentItem = TextContentItem | ImageUrlContentItem;

// 消息类型
interface Message {
  role: string;
  content: string | MessageContentItem[];
}

interface ChatRequest {
  model?: string;
  messages: Message[];
  stream?: boolean;
  size?: string;
  [key: string]: unknown;
}

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

function extractPromptAndImages(messages: Message[]): { prompt: string; images: string[] } {
  let prompt = "";
  let images: string[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const userContent = messages[i].content;
      if (typeof userContent === "string") {
        prompt = userContent;
      } else if (Array.isArray(userContent)) {
        const textItem = userContent.find((item: MessageContentItem) => item.type === "text") as TextContentItem | undefined;
        prompt = textItem?.text || "";
        
        images = userContent
          .filter((item: MessageContentItem): item is ImageUrlContentItem => item.type === "image_url")
          .map((item: ImageUrlContentItem) => item.image_url?.url || "")
          .filter(Boolean);
      }
      break;
    }
  }
  return { prompt, images };
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
  reqBody: ChatRequest,
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
  
  const model = reqBody.model || "doubao-seedream-4-0-250828";
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

  const response = await fetchWithTimeout(VOLC_API_URL, {
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
  reqBody: ChatRequest,
  prompt: string,
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  logApiCallStart("Gitee", "generate_image");

  // 记录完整 Prompt
  logFullPrompt("Gitee", requestId, prompt);
  
  const model = reqBody.model?.includes("z-image") ? reqBody.model : GITEE_DEFAULT_MODEL;
  const size = reqBody.size || "2048x2048";
  
  // 记录生成开始
  logImageGenerationStart("Gitee", requestId, model, size, prompt.length);

  const giteeRequest = {
    model: model,
    prompt: prompt || "A beautiful scenery",
    size: size,
    n: 1,
    response_format: "url"
  };

  debug("Gitee", `发送请求到: ${GITEE_API_URL}`);

  const response = await fetchWithTimeout(GITEE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "User-Agent": "Doubao-Seedream-Proxy/1.0"
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
  reqBody: ChatRequest,
  prompt: string,
  requestId: string
): Promise<string> {
  const startTime = Date.now();
  logApiCallStart("ModelScope", "generate_image");

  // 记录完整 Prompt
  logFullPrompt("ModelScope", requestId, prompt);
  
  const model = reqBody.model?.includes("Z-Image") ? reqBody.model : MODELSCOPE_DEFAULT_MODEL;
  const size = reqBody.size || "2048x2048";
  
  // 记录生成开始
  logImageGenerationStart("ModelScope", requestId, model, size, prompt.length);

  const submitResponse = await fetchWithTimeout(`${MODELSCOPE_API_URL}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "X-ModelScope-Async-Mode": "true"
    },
    body: JSON.stringify({
      model: model,
      prompt: prompt || "A beautiful scenery",
      size: size,
      n: 1
    }),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    const err = new Error(`ModelScope Submit Error (${submitResponse.status}): ${errorText}`);
    logImageGenerationFailed("ModelScope", requestId, errorText);
    logApiCallEnd("ModelScope", "generate_image", false, Date.now() - startTime);
    throw err;
  }

  const submitData = await submitResponse.json();
  const taskId = submitData.task_id;
  info("ModelScope", `任务已提交, Task ID: ${taskId}`);

  const maxAttempts = 60;
  let pollingAttempts = 0;
  
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    pollingAttempts++;

    const checkResponse = await fetchWithTimeout(`${MODELSCOPE_API_URL}/tasks/${taskId}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "X-ModelScope-Task-Type": "image_generation"
      }
    });

    if (!checkResponse.ok) {
      warn("ModelScope", `轮询警告: ${checkResponse.status}`);
      continue;
    }

    const checkData = await checkResponse.json();
    const status = checkData.task_status;

    if (status === "SUCCEED") {
      const imageUrls = checkData.output_images || [];
      
      // 记录生成的图片 URL
      const imageData = imageUrls.map((url: string) => ({ url }));
      logGeneratedImages("ModelScope", requestId, imageData);
      
      const duration = Date.now() - startTime;
      const imageCount = imageUrls.length;
      logImageGenerationComplete("ModelScope", requestId, imageCount, duration);
      
      const result = imageUrls.map((url: string) => `![Generated Image](${url})`).join("\n\n") || "图片生成失败";
      
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
    const requestBody: ChatRequest = await req.json();
    const isStream = requestBody.stream === true;
    const { prompt, images } = extractPromptAndImages(requestBody.messages || []);

    // 记录完整 Prompt（DEBUG 级别只记录摘要）
    debug("Router", `提取 Prompt: ${prompt?.substring(0, 80)}... (完整长度: ${prompt?.length || 0})`);

    let imageContent = "";
    
    switch (provider) {
      case "VolcEngine":
        imageContent = await handleVolcEngine(apiKey, requestBody, prompt, images, requestId);
        break;
      case "Gitee":
        imageContent = await handleGitee(apiKey, requestBody, prompt, requestId);
        break;
      case "ModelScope":
        imageContent = await handleModelScope(apiKey, requestBody, prompt, requestId);
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
