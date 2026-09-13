#!/usr/bin/env node
/**
 * 本地自测客户端：不开 ZCode 也能验证插件进程。
 *
 *   node scripts/test-client.mjs                       # 用假 Key 跑（验证握手、创建供应商、失败降级）
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/test-client.mjs   # 用真实 Key 跑（验证真实模型列表）
 *   node scripts/test-client.mjs --dry-run             # 只预览，不落盘
 *
 * 测试始终写到一个临时配置副本，不会碰你真实的 config.json。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "dist", "mcp", "server.js");
const dryRun = process.argv.includes("--dry-run");

function realConfigPath() {
  const home = os.homedir();
  for (const candidate of [
    path.join(home, ".zcode", "v2", "config.json"),
    path.join(home, ".zcode", "config.json"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const workdir = await mkdtemp(path.join(os.tmpdir(), "deepseek-plugin-test-"));
const configPath = path.join(workdir, "config.json");
const source = realConfigPath();
if (source) {
  await copyFile(source, configPath);
  console.log(`已把真实配置复制到临时文件：${configPath}`);
} else {
  await (await import("node:fs/promises")).writeFile(configPath, JSON.stringify({ provider: {} }, null, 2));
  console.log(`未找到真实配置，使用空配置：${configPath}`);
}

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    DEEPSEEK_PLUGIN_CONFIG: configPath,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || "sk-invalid-key-for-handshake-test",
    DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic",
  },
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => process.stderr.write(`  server| ${chunk}`));

let nextId = 1;
const pending = new Map();
let stdoutBuffer = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  let index;
  while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
    const line = stdoutBuffer.slice(0, index).trim();
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 30000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function show(title, value) {
  console.log(`\n=== ${title} ===`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "deepseek-plugin-test", version: "0.1.0" },
  });
  show("initialize", init.result);
  notify("notifications/initialized", {});

  const tools = await request("tools/list", {});
  show("tools/list", tools.result?.tools?.map((tool) => tool.name));

  const status = await request("tools/call", { name: "deepseek_status", arguments: {} });
  show("deepseek_status", status.result?.content?.[0]?.text);

  const sync = await request("tools/call", {
    name: "deepseek_sync",
    arguments: { dry_run: dryRun, overwrite_levels: false },
  });
  show(`deepseek_sync${dryRun ? " (dry_run)" : ""}`, sync.result?.content?.[0]?.text);

  // 等自动同步（会话启动时触发）也跑完，再看落盘结果
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const written = JSON.parse(await readFile(configPath, "utf8"));
  const providers = written.provider || {};
  const providerIds = Object.keys(providers);
  const deepseekId =
    providerIds.find((id) => /deepseek/i.test(id)) ||
    providerIds.find((id) =>
      String(providers[id]?.options?.baseURL || "").toLowerCase().includes("api.deepseek.com"),
    );
  show("临时配置里的 provider", providerIds);
  if (deepseekId) {
    const provider = written.provider[deepseekId];
    show(`provider.${deepseekId} 摘要`, {
      name: provider.name,
      kind: provider.kind,
      baseURL: provider.options?.baseURL,
      apiKey: provider.options?.apiKey ? `（${provider.options.apiKey.length} 字符）` : "未设置",
      models: Object.keys(provider.models || {}),
      sampleModel: Object.values(provider.models || {})[0]
        ? {
            limit: Object.values(provider.models)[0].limit,
            modalities: Object.values(provider.models)[0].modalities,
            reasoningVariants: Object.values(provider.models)[0].reasoning?.variants,
            levelPatches: Object.entries(
              Object.values(provider.models)[0].reasoningSpec?.levels || {},
            ).map(([name, spec]) => ({
              name,
              set: spec.anthropic?.set,
            })),
          }
        : null,
    });
  }
} finally {
  child.kill();
  console.log(`\n临时目录（可删）：${workdir}`);
  if (!process.env.DEEPSEEK_PLUGIN_KEEP_TMP) {
    await rm(workdir, { recursive: true, force: true });
    console.log("已清理临时目录。");
  }
}
