#!/usr/bin/env node
/**
 * DeepSeek integration for ZCode — MCP server + provider provisioning.
 *
 * 两件事：
 *   1) 把 DeepSeek 供应商（含每个模型的思考档位）幂等写入 ZCode 的供应商存储
 *      （~/.zcode/v2/config.json 的 provider 字段）。
 *   2) 暴露两个 MCP 工具，让 agent 能查状态、按需重新同步。
 *
 * 零依赖：手写 JSON-RPC 2.0 over stdio，不需要 npm install，也不需要构建步骤。
 * 协议消息走 stdout，日志一律走 stderr（stdout 只能有协议消息）。
 */

import { existsSync } from "node:fs";
import { copyFile, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// 可编辑配置（想改档位、改模型元数据，只动这一段就够了）
// ---------------------------------------------------------------------------

const PLUGIN_MARK = "deepseek"; // 插件在自己写入的模型条目上留下的归属标记
const PROVIDER_NAME = "DeepSeek";
const PROVIDER_ID_FALLBACK = "deepseek"; // 找不到已有供应商时新建用的 id
const DEEPSEEK_HOST = "api.deepseek.com"; // 用来识别「用户已有的 DeepSeek 供应商」
const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";

// 思考档位。删掉一行就少一档；想加档位照着加一行即可
// （DeepSeek 的 Anthropic 端点接受 low/medium/high/xhigh/ultra/max，其中
//  medium / xhigh / ultra 端点认、但 ZCode 界面没有对应中文标签，会显示英文原名）。
const THINKING_LEVELS = [
  { name: "off", effort: null, thinking: { type: "disabled" } },
  { name: "low", effort: "low", thinking: { type: "enabled", budgetTokens: 1024 } },
  { name: "high", effort: "high", thinking: { type: "enabled", budgetTokens: 1024 } },
  { name: "max", effort: "max", thinking: { type: "enabled", budgetTokens: 1024 } },
];
const DEFAULT_LEVEL = "max";

// 模型元数据。GET /models 只返回模型 id，不返回上下文窗口，所以在这里补。
// 拿不到预置值时用 MODEL_PRESET_FALLBACK，请按 DeepSeek 文档校正这张表。
const MODEL_PRESETS = {
  "deepseek-flash": { context: 1000000, output: 128000 },
  "deepseek-v4-flash": { context: 1000000, output: 128000 },
  "deepseek-v4-pro": { context: 1000000, output: 128000 },
  "deepseek-chat": { context: 128000, output: 32768 },
  "deepseek-reasoner": { context: 128000, output: 32768 },
};
const MODEL_PRESET_FALLBACK = { context: 128000, output: 32768 };

// DeepSeek 是纯文本模型。声明 image/video 会让 ZCode 允许挂载图片，然后在接口处报错。
const MODEL_INPUT_MODALITIES = ["text"];

// 端点的 /models 返回的 id 可能和历史配置 / 内置画像里的 id 等价
// （例如 deepseek-flash 与 deepseek-v4-flash 指向同一个模型）。
// 如果等价 id 已经存在于供应商里，就跳过新增，避免同一个模型在列表里出现两条。
const MODEL_ALIASES = {
  "deepseek-flash": ["deepseek-v4-flash"],
  "deepseek-v4-flash": ["deepseek-flash"],
};

const SERVER_INFO = { name: PLUGIN_MARK, version: "0.1.0" };
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

// ---------------------------------------------------------------------------
// 配置定位与读写
// ---------------------------------------------------------------------------

function candidateConfigPaths() {
  const home = os.homedir();
  const out = [];
  const override = (process.env.DEEPSEEK_PLUGIN_CONFIG || "").trim();
  if (override) out.push(override); // 调试用：指向别的 config.json
  out.push(path.join(home, ".zcode", "v2", "config.json"));
  out.push(path.join(home, ".zcode", "config.json"));
  return out;
}

async function resolveConfigPath() {
  for (const candidate of candidateConfigPaths()) {
    if (existsSync(candidate)) return candidate;
  }
  // 兜底：在 ~/.zcode/*/config.json 里挑最近修改、且带 provider 字段的那个
  const root = path.join(os.homedir(), ".zcode");
  let best = null;
  try {
    for (const entry of await readdir(root)) {
      const candidate = path.join(root, entry, "config.json");
      if (!existsSync(candidate)) continue;
      let hasProvider = false;
      try {
        hasProvider = Boolean(JSON.parse(await readFile(candidate, "utf8")).provider);
      } catch {
        // 解析失败就当它没有 provider
      }
      if (!hasProvider) continue;
      const mtimeMs = (await stat(candidate)).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs };
    }
  } catch {
    // ~/.zcode 不存在等情况下走下面的 null
  }
  return best ? best.path : null;
}

async function readConfig(file) {
  const data = JSON.parse(await readFile(file, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("config.json 顶层不是对象");
  }
  if (!data.provider || typeof data.provider !== "object" || Array.isArray(data.provider)) {
    data.provider = {};
  }
  return data;
}

async function writeConfig(file, data) {
  const backup = `${file}.deepseek-plugin.bak`;
  try {
    await copyFile(file, backup);
  } catch {
    // 首次写入时可能还没有原文件
  }
  const tmp = `${file}.deepseek-plugin.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, file); // libuv 在 Windows 上会做覆盖式重命名
  return backup;
}

// ---------------------------------------------------------------------------
// 插件设置（来自 plugin.json 的 userConfig，经 MCP env 注入）
// ---------------------------------------------------------------------------

function settings() {
  return {
    apiKey: (process.env.DEEPSEEK_API_KEY || "").trim(),
    baseURL: (process.env.DEEPSEEK_BASE_URL || "").trim() || DEFAULT_BASE_URL,
    overwriteLevels: /^(1|true|yes)$/i.test((process.env.DEEPSEEK_OVERWRITE_LEVELS || "").trim()),
  };
}

// ---------------------------------------------------------------------------
// 模型列表与条目生成
// ---------------------------------------------------------------------------

/** Anthropic 格式的 baseURL 去掉 /anthropic 后缀，就是列模型用的根地址。 */
function apiRoot(baseURL) {
  return baseURL.trim().replace(/\/+$/, "").replace(/\/anthropic$/i, "");
}

async function fetchModelIds(baseURL, apiKey, timeoutMs = 10000) {
  const url = `${apiRoot(baseURL)}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const body = await response.json();
    const ids = (Array.isArray(body?.data) ? body.data : [])
      .map((item) => (typeof item?.id === "string" ? item.id.trim() : ""))
      .filter(Boolean);
    if (ids.length === 0) throw new Error("接口没有返回任何模型");
    return [...new Set(ids)];
  } finally {
    clearTimeout(timer);
  }
}

/** 把档位表编译成 ZCode 认识的两种形态（两者都写，避免不同版本只认其中一种）。 */
function buildReasoningLevels(preferredNames = []) {
  const known = new Map(THINKING_LEVELS.map((level) => [level.name, level]));
  // 先按档位表的顺序排列（界面里排序自然），再把表里没有的自定义档位按原顺序追加。
  const keep = preferredNames.filter((name) => typeof name === "string" && name.trim());
  const tableNames = THINKING_LEVELS.map((level) => level.name);
  const extra = keep.filter((name) => !known.has(name));
  const names = [...tableNames, ...extra];

  const providerOptionsByLevel = {};
  const specLevels = {};

  for (const name of names) {
    const level = known.get(name);
    const anthropic = {};
    const patch = [];
    if (level?.effort) {
      anthropic.effort = level.effort;
      patch.push({ path: ["effort"], value: level.effort });
    }
    if (level?.thinking) {
      anthropic.thinking = { ...level.thinking };
      patch.push({ path: ["thinking"], value: { ...level.thinking } });
    }
    providerOptionsByLevel[name] = { anthropic };
    specLevels[name] = { anthropic: { set: patch } };
  }

  const defaultLevel = names.includes(DEFAULT_LEVEL) ? DEFAULT_LEVEL : names[0];
  return {
    reasoning: {
      enabled: true,
      variants: names,
      defaultVariant: defaultLevel,
      levels: names,
      defaultLevel,
      providerOptionsByLevel,
    },
    reasoningSpec: { defaultLevel, levels: specLevels },
  };
}

function buildModelEntry(modelId, preferredNames = []) {
  const preset = MODEL_PRESETS[modelId] || MODEL_PRESET_FALLBACK;
  const { reasoning, reasoningSpec } = buildReasoningLevels(preferredNames);
  return {
    limit: { context: preset.context, output: preset.output },
    modalities: { input: [...MODEL_INPUT_MODALITIES], output: ["text"] },
    zcode: { plugin: PLUGIN_MARK, modalitiesConfigured: true },
    reasoning,
    reasoningSpec,
  };
}

function modelLevelNames(model) {
  return reasoningState(model).levelNames;
}

function isPluginManaged(model) {
  return model?.zcode?.plugin === PLUGIN_MARK;
}

/**
 * 判断模型里的档位是否「能用」。
 *
 * ZCode 会把模型归一化成 { enabled, variants, defaultVariant } 并丢掉每档参数，
 * 于是档位名还在、但选中后不会发出任何 effort —— 这种只算「半个档位」，需要补全。
 * 所以这里区分：有档位名 vs 有档位名且带参数。
 */
function reasoningState(model) {
  const reasoning = model?.reasoning;
  const variants = Array.isArray(reasoning?.variants) ? reasoning.variants : [];
  const levels = Array.isArray(reasoning?.levels) ? reasoning.levels : [];
  const specLevels = model?.reasoningSpec?.levels;
  const specNames = specLevels && typeof specLevels === "object" ? Object.keys(specLevels) : [];
  const optionNames =
    reasoning?.providerOptionsByLevel && typeof reasoning.providerOptionsByLevel === "object"
      ? Object.keys(reasoning.providerOptionsByLevel)
      : [];

  const levelNames = variants.length ? variants : levels.length ? levels : specNames;
  return {
    levelNames,
    complete: levelNames.length > 0 && (optionNames.length > 0 || specNames.length > 0),
  };
}

// ---------------------------------------------------------------------------
// 同步（核心逻辑）
// ---------------------------------------------------------------------------

/**
 * 判断一个供应商是不是「DeepSeek 的」。
 *
 * 只看名字和 baseURL 会漏判：用户可能把它命名成 "DS"、或换过名字。
 * 所以供应商 id、模型 id 也一起看——模型 id 是最可靠的信号。
 */
function looksLikeDeepSeekProvider(providerId, provider) {
  const baseURL = typeof provider?.options?.baseURL === "string" ? provider.options.baseURL.toLowerCase() : "";
  if (baseURL.includes(DEEPSEEK_HOST)) return true;
  if (typeof provider?.name === "string" && /deepseek/i.test(provider.name)) return true;
  if (/deepseek/i.test(String(providerId))) return true;
  return Object.keys(provider?.models || {}).some((modelId) => /deepseek/i.test(modelId));
}

/**
 * 挑出插件要管理的那个供应商。
 *
 * 优先级：插件自己管理过的 > 有 API Key 的 > 有模型的 > 第一个。
 * 先看「插件管理过的」是为了稳定：一旦认领过，就不会因为候选顺序变化而跳到另一个供应商上。
 */
function findExistingProviderId(providers) {
  const candidates = Object.entries(providers || {}).filter(([id, provider]) =>
    looksLikeDeepSeekProvider(id, provider),
  );
  if (candidates.length === 0) return null;

  const rank = ([, provider]) => {
    const managed = Object.values(provider?.models || {}).some((model) => isPluginManaged(model)) ? 3 : 0;
    const key = typeof provider?.options?.apiKey === "string" && provider.options.apiKey.trim() ? 1 : 0;
    const models = provider?.models && Object.keys(provider.models).length > 0 ? 1 : 0;
    return managed + key + models;
  };
  return candidates.slice().sort((a, b) => rank(b) - rank(a))[0][0];
}

/** 其余看起来也是 DeepSeek、但插件不会去动的供应商，用于提示用户避免混淆。 */
function findOtherDeepSeekProviderIds(providers, managedId) {
  return Object.entries(providers || {})
    .filter(([id, provider]) => id !== managedId && looksLikeDeepSeekProvider(id, provider))
    .map(([id, provider]) => `${id}（名称：${provider?.name || "未命名"}）`);
}

async function sync(options = {}) {
  const defaults = settings();
  const apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : defaults.apiKey;
  const baseURL = typeof options.baseURL === "string" && options.baseURL.trim() ? options.baseURL.trim() : defaults.baseURL;
  const overwriteLevels = options.overwriteLevels === true || (options.overwriteLevels === undefined && defaults.overwriteLevels);
  const dryRun = options.dryRun === true;

  const report = {
    configPath: null,
    providerId: null,
    adopted: false,
    created: false,
    apiKeyWritten: false,
    keySource: null,
    added: [],
    levelAdded: [],
    completed: [],
    updated: [],
    unchanged: [],
    skipped: [],
    kept: [],
    otherProviders: [],
    fetchError: null,
    dryRun,
    wrote: false,
    messages: [],
  };

  const configPath = await resolveConfigPath();
  if (!configPath) {
    report.messages.push("找不到 ZCode 的 config.json（尝试过 ~/.zcode/v2/config.json 与 ~/.zcode/config.json）。");
    return report;
  }
  report.configPath = configPath;

  const data = await readConfig(configPath);
  const providers = data.provider;

  // 先只读地判断要复用还是新建，再拉模型列表；拉不到就什么都不写，
  // 避免留下一个「有供应商但没模型」的半成品。
  let providerId = findExistingProviderId(providers);
  const adopted = Boolean(providerId);
  if (!providerId) {
    providerId = PROVIDER_ID_FALLBACK;
    let suffix = 2;
    while (providers[providerId]) providerId = `${PROVIDER_ID_FALLBACK}-${suffix++}`;
  }
  const existing = providers[providerId] || null;
  const effectiveBaseURL = (existing?.options?.baseURL || "").trim() || baseURL;
  report.otherProviders = findOtherDeepSeekProviderIds(providers, providerId);

  // API Key 有两个来源：插件设置里填的值，或用户已经为 DeepSeek 供应商配好的那个。
  // 后者让用户可以完全不把 Key 交给插件（改为在「设置 → 模型供应商」里维护）。
  const providerKey = typeof existing?.options?.apiKey === "string" ? existing.options.apiKey.trim() : "";
  const effectiveKey = apiKey || providerKey;
  report.keySource = apiKey ? "plugin" : providerKey ? "provider" : null;
  if (!effectiveKey) {
    report.messages.push(
      "未配置 API Key：请在插件设置里填入 DeepSeek API Key，或在「设置 → 模型供应商」里为 DeepSeek 供应商配好 Key，任选其一。",
    );
    return report;
  }

  // 拉模型列表。DEEPSEEK_PLUGIN_MODELS 是调试用覆盖（跳过 /models 调用）。
  const mockedModels = (process.env.DEEPSEEK_PLUGIN_MODELS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  let modelIds = [];
  try {
    modelIds = mockedModels.length > 0 ? mockedModels : await fetchModelIds(effectiveBaseURL, effectiveKey);
  } catch (error) {
    report.fetchError = error instanceof Error ? error.message : String(error);
    report.messages.push(
      `拉取模型列表失败（${report.fetchError}）：本次不做任何写入，请检查 API Key / 网络 / 端点后重新同步。`,
    );
    return report;
  }

  let provider = existing;
  if (provider) {
    report.adopted = true;
  } else {
    provider = {
      name: PROVIDER_NAME,
      kind: "anthropic",
      options: { apiKey, baseURL: effectiveBaseURL, apiKeyRequired: true },
      source: "custom",
      models: {},
    };
    providers[providerId] = provider;
    report.created = true;
  }

  if (!provider.options || typeof provider.options !== "object") provider.options = {};
  if (typeof provider.options.baseURL !== "string" || !provider.options.baseURL.trim()) {
    provider.options.baseURL = baseURL;
  }
  // 只在插件里确实填了 Key、且与现值不同时才写；Key 来自供应商自身时不动它。
  if (apiKey && provider.options.apiKey !== apiKey) {
    provider.options.apiKey = apiKey;
    report.apiKeyWritten = true;
  }
  if (!provider.models || typeof provider.models !== "object" || Array.isArray(provider.models)) {
    provider.models = {};
  }
  report.providerId = providerId;

  for (const modelId of modelIds) {
    const existing = provider.models[modelId];
    const state = existing ? reasoningState(existing) : { levelNames: [], complete: false };
    // 传已有的档位名进去，保留用户/应用定义的档位集合与顺序
    const entry = buildModelEntry(modelId, state.levelNames);

    if (!existing) {
      const equivalent = (MODEL_ALIASES[modelId] || []).find((alias) => provider.models[alias]);
      if (equivalent) {
        report.skipped.push(`${modelId}（等价于已有的 ${equivalent}）`);
        continue;
      }
      provider.models[modelId] = entry;
      report.added.push(modelId);
      continue;
    }

    const managed = isPluginManaged(existing);
    const next = { ...existing };

    if (state.levelNames.length === 0 || !state.complete) {
      // 没有档位，或只有档位名却没有每档参数（ZCode 会把模型归一化成
      // { enabled, variants, defaultVariant } 并丢掉参数）——两种情况都补全。
      next.reasoning = entry.reasoning;
      next.reasoningSpec = entry.reasoningSpec;
      next.zcode = { ...(existing.zcode || {}), plugin: PLUGIN_MARK };
      if (state.levelNames.length === 0) report.levelAdded.push(modelId);
      else report.completed.push(modelId);
    } else if (managed || overwriteLevels) {
      const before = JSON.stringify(existing.reasoning) + JSON.stringify(existing.reasoningSpec);
      next.reasoning = entry.reasoning;
      next.reasoningSpec = entry.reasoningSpec;
      next.zcode = { ...(existing.zcode || {}), plugin: PLUGIN_MARK };
      const after = JSON.stringify(next.reasoning) + JSON.stringify(next.reasoningSpec);
      if (before === after) {
        report.unchanged.push(modelId);
        continue;
      }
      report.updated.push(modelId);
    } else {
      report.kept.push(modelId);
      continue;
    }

    if (next.limit === undefined) next.limit = entry.limit;
    if (next.modalities === undefined) next.modalities = entry.modalities;
    provider.models[modelId] = next;
  }

  // 第二遍：供应商里已有、但端点没返回的模型（比如内置画像用的 deepseek-v4-* 别名，
  // 或用户手工添过的模型）。只补全「有档位名却没有每档参数」的，绝不新增档位，
  // 以免给非推理模型凭空加上思考档位。
  for (const [modelId, model] of Object.entries(provider.models)) {
    if (modelIds.includes(modelId)) continue;
    const state = reasoningState(model);
    if (state.levelNames.length === 0 || state.complete) continue;
    const entry = buildModelEntry(modelId, state.levelNames);
    provider.models[modelId] = {
      ...model,
      reasoning: entry.reasoning,
      reasoningSpec: entry.reasoningSpec,
      zcode: { ...(model.zcode || {}), plugin: PLUGIN_MARK },
    };
    report.completed.push(modelId);
  }

  const changed = report.created || report.apiKeyWritten || report.added.length > 0 ||
    report.levelAdded.length > 0 || report.completed.length > 0 || report.updated.length > 0;

  if (changed && !dryRun) {
    await writeConfig(configPath, data);
    report.wrote = true;
  }

  if (report.fetchError) {
    report.messages.push(`拉取模型列表失败（${report.fetchError}）：未写入任何模型，请稍后调用 deepseek_sync 重试。`);
  }
  if (changed) {
    report.messages.push("配置已更新：需要重启 ZCode（或新开会话）后才会加载新的供应商/模型/档位。");
  } else {
    report.messages.push("没有需要变更的内容。");
  }
  if (report.otherProviders.length > 0) {
    report.messages.push(
      `另外还有 ${report.otherProviders.length} 个看起来也是 DeepSeek 的供应商，插件不会改动它们：${report.otherProviders.join("、")}。` +
        "如果不是你在用的那个，建议在「设置 → 模型供应商」里删掉或改名，避免模型列表里出现重复项。",
    );
  }
  return report;
}

function formatReport(report) {
  const lines = [];
  lines.push(report.dryRun ? "DeepSeek 同步预览（未落盘）" : "DeepSeek 同步结果");
  lines.push(`配置文件：${report.configPath ?? "未找到"}`);
  if (report.providerId) {
    const origin = report.created ? "新建" : report.adopted ? "复用已有供应商" : "未知";
    lines.push(`供应商：${report.providerId}（${origin}）`);
  }
  if (report.apiKeyWritten) lines.push("API Key：已写入（不回显内容）");
  else if (report.keySource === "provider") lines.push("API Key：使用供应商里已有的 Key（插件未保存副本）");
  if (report.added.length) lines.push(`新增模型：${report.added.join(", ")}`);
  if (report.levelAdded.length) lines.push(`补写档位：${report.levelAdded.join(", ")}`);
  if (report.completed.length) {
    lines.push(`补全档位参数（原有档位只有名字、没有每档参数）：${report.completed.join(", ")}`);
  }
  if (report.updated.length) lines.push(`刷新档位：${report.updated.join(", ")}`);
  if (report.skipped.length) lines.push(`跳过（已有等价模型）：${report.skipped.join(", ")}`);
  if (report.unchanged.length) lines.push(`无变化：${report.unchanged.join(", ")}`);
  if (report.kept.length) {
    lines.push(`未覆盖（已有完整的档位配置，需要时用 overwrite_levels 强制刷新）：${report.kept.join(", ")}`);
  }
  for (const message of report.messages) lines.push(message);
  return lines.join("\n");
}

async function statusReport() {
  const configPath = await resolveConfigPath();
  const defaults = settings();
  const lines = ["DeepSeek 集成状态"];
  lines.push(`配置文件：${configPath ?? "未找到"}`);
  lines.push(`API Key（插件设置）：${defaults.apiKey ? `已配置（${defaults.apiKey.length} 字符，不回显内容）` : "未配置"}`);
  lines.push(`端点：${defaults.baseURL}`);
  lines.push(`档位表：${THINKING_LEVELS.map((level) => level.name).join(" / ")}（默认 ${DEFAULT_LEVEL}）`);

  if (!configPath) {
    lines.push("找不到 ZCode 配置，无法检查供应商。");
    return lines.join("\n");
  }

  let providers;
  try {
    providers = (await readConfig(configPath)).provider;
  } catch (error) {
    lines.push(`读取配置失败：${error instanceof Error ? error.message : String(error)}`);
    return lines.join("\n");
  }

  const providerId = findExistingProviderId(providers);
  if (!providerId) {
    lines.push("供应商：未找到 DeepSeek 供应商。");
    lines.push(
      defaults.apiKey
        ? "填入的 Key 已就绪，重启 ZCode 后插件会自动创建供应商。"
        : "请填入 API Key（插件设置），或在「设置 → 模型供应商」里手动创建一个 DeepSeek 供应商并填上 Key。",
    );
    return lines.join("\n");
  }

  const provider = providers[providerId];
  const models = Object.keys(provider.models || {});
  const providerKey = typeof provider.options?.apiKey === "string" ? provider.options.apiKey.trim() : "";
  const effectiveSource = defaults.apiKey ? "插件设置" : providerKey ? "供应商配置" : null;
  lines.push(`供应商：${providerId}（${provider.name || "未命名"}）`);
  lines.push(`端点：${provider.options?.baseURL ?? "未设置"}`);
  lines.push(`模型：${models.length} 个`);
  lines.push(
    effectiveSource
      ? `可用 API Key 来源：${effectiveSource}${effectiveSource === "供应商配置" ? "（插件不保存副本）" : ""}`
      : "可用 API Key 来源：无 —— 请在插件设置里填写，或为上面的供应商配上 Key",
  );
  for (const modelId of models) {
    const model = provider.models[modelId];
    const state = reasoningState(model);
    const scope = isPluginManaged(model) ? "插件管理" : state.complete ? "用户配置" : "档位缺参数，sync 可补全";
    const context = model?.limit?.context ?? "?";
    lines.push(
      `  - ${modelId}  档位：${state.levelNames.length ? state.levelNames.join("/") : "无"}  上下文：${context}  [${scope}]`,
    );
  }
  const others = findOtherDeepSeekProviderIds(providers, providerId);
  if (others.length > 0) {
    lines.push(`另有未接管的 DeepSeek 供应商（插件不改动）：${others.join("、")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MCP 服务器（JSON-RPC 2.0 over stdio）
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "deepseek_status",
    title: "DeepSeek 集成状态",
    description:
      "查看 DeepSeek 供应商是否已写入 ZCode 配置、包含哪些模型与思考档位、API Key 是否就绪。不会输出密钥内容。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "deepseek_sync",
    title: "同步 DeepSeek 模型与档位",
    description:
      "从 DeepSeek 的 /models 端点拉取模型列表，把模型与思考档位幂等写入 ZCode 配置。默认只补缺失项，不覆盖用户已有配置。写入后需重启 ZCode 才生效。",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: { type: "boolean", description: "只预览将要写入的变更，不落盘。默认 false。" },
        overwrite_levels: { type: "boolean", description: "连已有模型的思考档位一起覆盖。默认 false。" },
      },
      additionalProperties: false,
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(message) {
  process.stderr.write(`[${PLUGIN_MARK}-plugin] ${message}\n`);
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function handleToolCall(params) {
  const name = params?.name;
  const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
  if (name === "deepseek_status") return textResult(await statusReport());
  if (name === "deepseek_sync") {
    const report = await sync({
      dryRun: args.dry_run === true,
      overwriteLevels: args.overwrite_levels === true,
    });
    return textResult(formatReport(report));
  }
  return textResult(`未知工具：${String(name)}`, true);
}

async function handleRequest(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: typeof requested === "string" && requested ? requested : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions:
            "DeepSeek 集成插件：用户只需在插件设置里填写 API Key。用 deepseek_status 查状态，用 deepseek_sync 同步模型与思考档位。",
        },
      });
      scheduleAutoSync();
      return;
    }
    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    case "tools/call": {
      try {
        send({ jsonrpc: "2.0", id, result: await handleToolCall(params) });
      } catch (error) {
        send({
          jsonrpc: "2.0",
          id,
          result: textResult(`执行失败：${error instanceof Error ? error.message : String(error)}`, true),
        });
      }
      return;
    }
    case "resources/list":
      send({ jsonrpc: "2.0", id, result: { resources: [] } });
      return;
    case "prompts/list":
      send({ jsonrpc: "2.0", id, result: { prompts: [] } });
      return;
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(method)}` } });
  }
}

let autoSyncStarted = false;

/** 会话启动时自动同步一次：这是「只填 key 就能用」的关键一步。 */
function scheduleAutoSync() {
  if (autoSyncStarted) return;
  autoSyncStarted = true;
  if (process.env.DEEPSEEK_PLUGIN_AUTO_SYNC === "0") {
    log("自动同步已禁用（DEEPSEEK_PLUGIN_AUTO_SYNC=0）");
    return;
  }
  setTimeout(() => {
    sync()
      .then((report) => log(formatReport(report)))
      .catch((error) => log(`自动同步失败：${error instanceof Error ? error.message : String(error)}`));
  }, 250).unref?.();
}

let buffer = "";

function onData(chunk) {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log("忽略无法解析的输入行");
      continue;
    }
    // 没有 id 的是通知（notifications/initialized 等），不需要回包
    if (message?.id === undefined || message?.id === null) continue;
    handleRequest(message).catch((error) => {
      log(`处理 ${String(message?.method)} 失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

function main() {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onData);
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
  log("已启动，等待握手");
}

main();

export { main, sync, statusReport, formatReport, buildModelEntry, resolveConfigPath };
