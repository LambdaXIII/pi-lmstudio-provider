/**
 * pi-lmstudio-provider
 *
 * pi-coding-agent 的 LM Studio 本地模型自动接入插件。
 *
 * 架构：
 *   - 模型发现：用 LM Studio 原生 API /api/v1/models 获取丰富的模型元数据
 *   - 端口检测：依次扫描常见端口，环境变量 LMSTUDIO_PORT 可手动覆盖
 *   - 推理通信：通过 OpenAI 兼容层 /v1/chat/completions（支持工具调用）
 *   - 参数策略：temperature 等采样参数不主动设置，由 LM Studio GUI 配置生效
 *
 * 命令：
 *   /lmstudio       - 检测并注册模型，输出当前状态
 *   /lmstudio off   - 临时卸载（仅当前会话，下次启动自动恢复）
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── 配置 ─────────────────────────────────────────────────────────────────────

/** 端口扫描列表，依次尝试，首个可用即选用 */
const SCAN_PORTS = (process.env.LMSTUDIO_PORT ?? "1234,8080")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean)
  .map(Number);

const PROVIDER_NAME = "lmstudio";
const DETECT_TIMEOUT_MS = 2000; // 每个端口超时 2 秒

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

/**
 * /api/v1/models 返回的模型对象（LM Studio 原生格式）
 */
interface LMStudioNativeModel {
  id: string;
  type: "llm" | "vlm" | "embeddings" | string;
  publisher?: string;
  arch?: string;
  compatibility_type?: string;
  quantization?: string;
  state: "loaded" | "not-loaded" | string;
  max_context_length?: number;
}

interface LMStudioNativeResponse {
  data: LMStudioNativeModel[];
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 带超时的 fetch
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 自动检测 LM Studio 端口
 * 依次尝试 SCAN_PORTS 中的端口，返回首个可用的 baseUrl
 * 返回 null 表示全部不可用
 */
async function detectPort(): Promise<{ baseUrl: string; port: number } | null> {
  for (const port of SCAN_PORTS) {
    try {
      const resp = await fetchWithTimeout(
        `http://localhost:${port}/api/v1/models`,
        DETECT_TIMEOUT_MS
      );
      if (resp.ok) return { baseUrl: `http://localhost:${port}`, port };
    } catch {
      // 连接失败 → 尝试下一个端口
    }
  }
  return null;
}

/**
 * 通过 LM Studio 原生 API 获取模型列表
 * 使用 LM Studio 原生 API /api/v1/models，获取更丰富的元数据（比 OpenAI 兼容层多 context_length、type、quantization 等字段）
 */
async function fetchNativeModels(
  baseUrl: string
): Promise<LMStudioNativeModel[]> {
  const resp = await fetchWithTimeout(
    `${baseUrl}/api/v1/models`,
    DETECT_TIMEOUT_MS
  );
  if (!resp.ok) return [];
  const json = (await resp.json()) as LMStudioNativeResponse;
  return Array.isArray(json.data) ? json.data : [];
}

// ─── Provider 注册 ──────────────────────────────────────────────────────────────

let currentBaseUrl: string | null = null;

function unregisterProvider(pi: ExtensionAPI): void {
  try {
    pi.unregisterProvider(PROVIDER_NAME);
    currentBaseUrl = null;
  } catch {
    // provider 不存在则忽略
  }
}

/**
 * 注册 LM Studio 为 pi provider
 *
 * 推理走 OpenAI 兼容层 /v1/chat/completions（支持工具调用），
 * 不传 temperature 等采样参数，让 LM Studio 服务端配置生效。
 */
async function registerProvider(
  pi: ExtensionAPI,
  baseUrl: string,
  models: LMStudioNativeModel[]
): Promise<void> {
  // 只注册 LLM 和 VLM 类型，排除 embeddings 等非对话模型
  const chatModels = models.filter(
    (m) => m.type === "llm" || m.type === "vlm"
  );

  if (chatModels.length === 0) return;

  const piModels = chatModels.map((m) => ({
    id: m.id,
    name: m.id,
    input: (m.type === "vlm"
      ? ["text", "image"]
      : ["text"]) as ("text" | "image")[],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // 使用原生 API 返回的真实上下文窗口，回退到 32768
    contextWindow: m.max_context_length ?? 32768,
    maxTokens: 8192,
  }));

  pi.registerProvider(PROVIDER_NAME, {
    baseUrl: `${baseUrl}/v1`,
    // LM Studio 默认不需要 API Key；如果用户配置了认证，通过环境变量传入
    apiKey: process.env.LM_API_KEY ?? "lm-studio",
    api: "openai-completions",
    models: piModels,
  });

  currentBaseUrl = baseUrl;
}

// ─── 主逻辑：检测 + 注册 ────────────────────────────────────────────────────────

interface DetectResult {
  found: boolean;
  baseUrl: string | null;
  port: number | null;
  count: number;
}

/**
 * 格式化模型列表为可读文本
 */
function formatModelList(models: LMStudioNativeModel[]): string {
  return models
    .map(
      (m, i) =>
        `  ${i + 1}. ${m.id}` +
        (m.max_context_length ? ` (${m.max_context_length} ctx)` : "") +
        (m.quantization ? ` [${m.quantization}]` : "")
    )
    .join("\n");
}

async function detectAndRegister(
  pi: ExtensionAPI,
  ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
  silent = false
): Promise<DetectResult> {
  // 步骤 1：端口探测
  const detected = await detectPort();

  if (!detected) {
    if (!silent && ctx.hasUI) {
      ctx.ui.notify(
        `LM Studio not found (scanned ports: ${SCAN_PORTS.join(", ")}). Make sure LM Studio is running with local server enabled.`,
        "warning"
      );
    }
    return { found: false, baseUrl: null, port: null, count: 0 };
  }

  const { baseUrl, port } = detected;

  // 步骤 2：通过原生 API 获取模型元数据
  const models = await fetchNativeModels(baseUrl);

  // 过滤出可注册的模型
  const chatModels = models.filter(
    (m) => m.type === "llm" || m.type === "vlm"
  );

  if (chatModels.length === 0) {
    if (!silent && ctx.hasUI) {
      ctx.ui.notify(
        `LM Studio running on :${port}, but no LLM/VLM model loaded.`,
        "warning"
      );
    }
    return { found: true, baseUrl, port, count: 0 };
  }

  // 步骤 3：注册
  unregisterProvider(pi);
  await registerProvider(pi, baseUrl, models);

  if (!silent && ctx.hasUI) {
    ctx.ui.notify(
      `LM Studio on :${port} - ${chatModels.length} model(s) registered:\n${formatModelList(chatModels)}`,
      "info"
    );
  }

  return { found: true, baseUrl, port, count: chatModels.length };
}

// ─── 扩展入口 ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // 1. 启动时自动检测（静默模式）
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    await detectAndRegister(pi, ctx, true);
  });

  // 2. /lmstudio - 检测/刷新 + 显示状态 / off 临时卸载
  pi.registerCommand("lmstudio", {
    description:
      "Detect LM Studio and register models. Append 'off' to temporarily disable for this session.",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();

      if (sub === "off") {
        if (!currentBaseUrl) {
          if (ctx.hasUI) ctx.ui.notify("LM Studio is not active.", "info");
          return;
        }
        unregisterProvider(pi);
        if (ctx.hasUI) {
          ctx.ui.notify("LM Studio disabled for this session. It will auto-reconnect on next restart.", "info");
        }
        return;
      }

      // 如果已注册，先获取当前模型列表用于展示
      const existingModels = currentBaseUrl
        ? await fetchNativeModels(currentBaseUrl)
        : [];

      // 重新检测并注册
      const result = await detectAndRegister(pi, ctx, false);

      // 如果重新检测失败但之前有注册，展示旧状态
      if (!result.found && existingModels.length > 0 && currentBaseUrl) {
        const chatModels = existingModels.filter(
          (m) => m.type === "llm" || m.type === "vlm"
        );
        if (chatModels.length > 0 && ctx.hasUI) {
          ctx.ui.notify(
            `LM Studio appears offline. Previously registered models:\n${formatModelList(chatModels)}`,
            "warning"
          );
        }
      }
    },
  });
}
