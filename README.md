# ImgRouter

> 三合一图像生成 API 中转服务 - 一个接口，多渠道图像生成

[![Deno](https://img.shields.io/badge/Deno-2.x-000000?logo=deno)](https://deno.land/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## 特性

- **智能路由** - 根据 API Key 格式自动识别并分发到对应渠道
- **三渠道支持** - 火山引擎、Gitee (模力方舟)、ModelScope (魔塔)
- **OpenAI 兼容** - 完全兼容 `/v1/chat/completions` 接口格式
- **流式响应** - 支持 SSE 流式输出
- **图片参考** - 支持上传参考图片进行图生图
- **Docker 部署** - 开箱即用的容器化部署方案
- **详细日志** - 完整的请求/响应日志记录

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                      客户端请求                              │
│              POST /v1/chat/completions                      │
└─────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                   API Key 检测器                             │
│  ┌─────────────┬─────────────────┬─────────────────────┐    │
│  │ ms-*        │ UUID 格式       │ 30-60位字母数字      │    │
│  │ → ModelScope│ → VolcEngine    │ → Gitee             │    │
│  └─────────────┴─────────────────┴─────────────────────┘    │
└─────────────────────┬───────────────────────────────────────┘
                       │
           ┌───────────┼───────────┐
           ▼           ▼           ▼
     ┌──────────┐ ┌──────────┐ ┌──────────┐
     │VolcEngine│ │  Gitee   │ │ModelScope│
     │ (火山)   │ │(模力方舟)│ │  (魔塔)  │
     └──────────┘ └──────────┘ └──────────┘
```

## 快速开始

### Docker Compose (推荐)

```bash
git clone https://github.com/TheWiseWolfHolo/img-router.git
cd img-router
docker-compose up -d
```

### Docker 直接运行

```bash
docker build -t img-router .
docker run -d --name img-router -p 10001:10001 img-router
```

### 本地开发

```bash
# 安装 Deno
# Windows: irm https://deno.land/install.ps1 | iex
# macOS/Linux: curl -fsSL https://deno.land/install.sh | sh

# 开发模式
deno task dev

# 生产模式
deno task start
```

## 使用方法

### 基本请求

```bash
curl -X POST http://localhost:10001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "doubao-seedream-4-0-250828",
    "messages": [{"role": "user", "content": "一只可爱的猫咪"}],
    "size": "1024x1024"
  }'
```

### 带参考图片

```bash
curl -X POST http://localhost:10001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "doubao-seedream-4-0-250828",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "转换为水彩画风格"},
        {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg"}}
      ]
    }]
  }'
```

### 流式响应

```bash
curl -X POST http://localhost:10001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "doubao-seedream-4-0-250828",
    "messages": [{"role": "user", "content": "美丽的风景"}],
    "stream": true
  }'
```

### multipart/form-data（兼容部分客户端文件上传）

当客户端以表单上传图片时：
- `payload`: 原始 OpenAI 兼容请求 JSON 字符串
- `file`/`image`: 图片文件（可多文件）

示例：

```bash
curl -X POST http://localhost:10001/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F 'payload={"model":"doubao-seedream-4-0-250828","messages":[{"role":"user","content":"转换为水彩画风格"}]}' \
  -F "image=@./input.png;type=image/png"
```

## API Key 格式

| 渠道 | 格式 | 示例 |
|------|------|------|
| 火山引擎 | UUID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| Gitee | 30-60位字母数字 | `abc123def456...` |
| ModelScope | `ms-` 开头 | `ms-xxxxxxxxxx` |

系统根据 API Key 格式自动识别渠道，无需手动指定。

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口 | `10001` |
| `LOG_LEVEL` | 日志级别 | `INFO` |
| `IMAGE_INPUT_MODE` | 图片输入策略：`passthrough`/`fetch_to_base64` | `fetch_to_base64` |
| `IMAGE_BASE64_FORMAT` | base64 提交格式：`data_url`/`raw_base64` | `data_url` |
| `IMAGE_FETCH_TIMEOUT_MS` | 拉取远程图片超时（毫秒） | `10000` |
| `MAX_IMAGE_BYTES` | 图片最大体积（字节） | `10485760` (10MB) |
| `ALLOW_PRIVATE_IMAGE_FETCH` | 是否允许拉取 localhost/内网地址（不建议开启） | `false` |

> 可按渠道覆盖：`VOLCENGINE_IMAGE_INPUT_MODE` / `GITEE_IMAGE_INPUT_MODE` / `MODELSCOPE_IMAGE_INPUT_MODE`，以及 `*_IMAGE_BASE64_FORMAT`。

### 默认模型

| 渠道 | 默认模型 |
|------|---------|
| 火山引擎 | `doubao-seedream-4-0-250828` |
| Gitee | `z-image-turbo` |
| ModelScope | `Tongyi-MAI/Z-Image-Turbo` |

## 响应格式

### 成功响应

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1734323445,
  "model": "doubao-seedream-4-0-250828",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "![Generated Image](https://example.com/image.jpg)"
    },
    "finish_reason": "stop"
  }]
}
```

### 错误响应

```json
{
  "error": {
    "message": "API Error: ...",
    "type": "server_error",
    "provider": "VolcEngine"
  }
}
```

## 开发

```bash
deno fmt      # 格式化代码
deno lint     # 代码检查
deno check main.ts  # 类型检查
```

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！
