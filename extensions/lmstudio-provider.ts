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
  key: string;
  type: "llm" | "vlm" | "embedding" | string;
  display_name?: string;
  publisher?: string;
  architecture?: string;
  quantization?: { name: string; bits_per_weight?: number };
  loaded_instances?: unknown[];
  max_context_length?: number;
  capabilities?: { vision?: boolean; reasoning?: unknown; trained_for_tool_use?: boolean };
  selected_variant?: string;
}

interface LMStudioNativeResponse {
  models: LMStudioNativeModel[];
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
  return Array.isArray(json.models) ? json.models : [];
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
 * 同步注册 LM Studio provider（扩展加载时立即执行）
 *
 * 注册时 models 列表为空，pi 的 openai-completions 内置实现
 * 会自动调用 /v1/models 端点获取可用模型。
 */
function registerProviderSync(pi: ExtensionAPI, port: number): void {
  pi.registerProvider(PROVIDER_NAME, {
    baseUrl: `http://localhost:${port}/v1`,
    apiKey: process.env.LM_API_KEY ?? "lm-studio",
    api: "openai-completions",
    models: [],
  });
  currentBaseUrl = `http://localhost:${port}`;
}

/**
 * 异步更新已注册 provider 的模型列表
 * 通过 LM Studio 原生 API 获取模型元数据后，重新注册 provider（覆盖空壳）
 */
async function registerProvider(
  pi: ExtensionAPI,
  baseUrl: string,
  models: LMStudioNativeModel[]
): Promise<void> {
  // 排除 embedding 类型，其余全部注册（含 not-loaded，LM Studio 会自动加载）
  const chatModels = models.filter((m) => m.type !== "embedding");

  if (chatModels.length === 0) return;

  const piModels = chatModels.map((m) => ({
    // 优先用 selected_variant（如 "qwen/qwen3.5-9b@q4_k_m"），回退到 key
    id: m.selected_variant ?? m.key,
    name: m.display_name ?? m.key,
    input: (m.capabilities?.vision
      ? ["text", "image"]
      : ["text"]) as ("text" | "image")[],
    // 如果模型支持 reasoning 且默认开启
    reasoning:
      typeof m.capabilities?.reasoning === "object" &&
      m.capabilities.reasoning !== null,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.max_context_length ?? 32768,
    maxTokens: 8192,
  }));

  pi.registerProvider(PROVIDER_NAME, {
    baseUrl: `${baseUrl}/v1`,
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
        `  ${i + 1}. ${m.display_name ?? m.key}` +
        (m.max_context_length ? ` (${m.max_context_length} ctx)` : "") +
        (m.quantization?.name ? ` [${m.quantization.name}]` : "")
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

  // 过滤出可注册的模型（排除 embeddings，保留所有其他类型，含 not-loaded）
  const chatModels = models.filter((m) => m.type !== "embeddings");

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

/**
 * 扩展入口：注册 LM Studio provider。
 *
 * pi 加载扩展后立即检查可用模型，不会 await 异步操作。
 * 这里同步注册 provider，让 pi 的 openai-completions 内置实现
 * 自行连接 LM Studio 并通过 /v1/models 获取模型列表。
 *
 * session_start 时异步探测并用原生 API 更新模型元数据。
 */
export default function (pi: ExtensionAPI) {
  const firstPort = SCAN_PORTS[0] ?? 1234;

  // 同步注册：让 pi 立即识别 lmstudio provider
  // openai-completions 内置实现会自动调用 /v1/models 获取模型
  registerProviderSync(pi, firstPort);

  // session_start 时异步用原生 API 更新模型元数据
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    await detectAndRegister(pi, ctx, true);
  });

  // /lmstudio - 检测/刷新 + 显示状态 / off 临时卸载
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
        const chatModels = existingModels.filter((m) => m.type !== "embeddings");
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
