// ================= 渠道配置 =================
// 支持：火山引擎 (VolcEngine/豆包)、Gitee (模力方舟)、ModelScope (魔塔)

// 渠道配置接口
export interface ProviderConfig {
  apiUrl: string;
  defaultModel: string;
  supportedModels: string[];
}

// 火山引擎（豆包）配置
export const VolcEngineConfig: ProviderConfig = {
  apiUrl: "https://ark.cn-beijing.volces.com/api/v3/images/generations",
  defaultModel: "doubao-seedream-4-0-250828",
  supportedModels: [
    "doubao-seedream-4-0-250828",
    "doubao-seedream-4-5-251128",
  ],
};

// Gitee（模力方舟）配置
export const GiteeConfig: ProviderConfig = {
  apiUrl: "https://ai.gitee.com/v1/images/generations",
  defaultModel: "z-image-turbo",
  supportedModels: [
    "z-image-turbo",
  ],
};

// ModelScope（魔塔）配置
export const ModelScopeConfig: ProviderConfig = {
  apiUrl: "https://api-inference.modelscope.cn/v1",
  defaultModel: "Tongyi-MAI/Z-Image-Turbo",
  supportedModels: [
    "z-image-turbo",
  ],
};

// 统一超时时间：120秒（适用于所有渠道的 API 请求）
export const API_TIMEOUT_MS = 120000;

// 服务端口
function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}

export const PORT = parsePort(Deno.env.get("PORT"), 10001);
