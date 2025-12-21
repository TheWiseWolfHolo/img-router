# 使用 Deno 官方镜像
FROM denoland/deno:latest

# 设置工作目录
WORKDIR /app

# 复制应用代码
COPY main.ts .
COPY deno.json .
COPY logger.ts .

# 缓存依赖（如果有的话）
RUN deno cache main.ts

# 暴露端口（默认 10001）
EXPOSE 10001

# 运行应用
# --allow-net: 允许网络访问（调用火山引擎 API）
# --allow-env: 允许读取环境变量
# --allow-write: 允许写入日志文件
CMD ["run", "--allow-net", "--allow-env", "--allow-write", "main.ts"]