---
name: deepseek
description: 用 DeepSeek 插件的 MCP 工具检查状态、拉取模型、同步思考档位。当用户提到 DeepSeek 供应商配置、DeepSeek 模型缺失、思考档位（关/低/高/最高）不生效或被限制为「关/高/最高」、或要把 DeepSeek 接入 ZCode 时使用。
---

# DeepSeek 集成

这个插件把 DeepSeek 供应商写进 ZCode 的供应商存储，让用户只填一个 API Key 就能用上模型和思考档位。

## 工具

在 ZCode 里，MCP 工具暴露为 `mcp__deepseek__<tool>`：

- `mcp__deepseek__deepseek_status` — 查状态：供应商是否存在、有哪些模型与档位、API Key 是否就绪（不输出密钥内容）。
- `mcp__deepseek__deepseek_sync` — 拉取 `/models` 并幂等写入配置。参数：`dry_run`（只预览）、`overwrite_levels`（覆盖已有档位，默认 false）。

## 它写了什么

写进 `~/.zcode/v2/config.json` 的 `provider.<id>`：

- `kind: "anthropic"` + `options.baseURL` 指向 `https://api.deepseek.com/anthropic`；
- `models.<modelId>`：`limit`（上下文/输出）、`modalities`（纯文本）、`reasoning` 与 `reasoningSpec` 两套档位定义；
- `zcode.plugin = "deepseek"`：插件在自己写入的模型条目上留的归属标记，用于判断「这是我写的，可以刷新」还是「这是用户写的，别动」。

档位定义 = 每个档位一组 provider options（`anthropic.effort` + `anthropic.thinking`），默认档位表在 `dist/mcp/server.js` 的 `THINKING_LEVELS`。

**但要注意（实测）**：写进配置的档位只决定界面上列出哪些档位，**不决定实际发出的参数**。每档参数由 ZCode 运行时按模型 id 匹配内置画像给出：以 `deepseek-v4` 开头的 id → 深度画像（`high`/`max` 带 effort）；其它 `deepseek*` id → 只有开关画像，**任何档位都不发 effort**。所以模型 id 必须规范化成 `deepseek-v4-*`（插件会自动做），而内置画像里没有的档位（如 `low`）选了什么都不会带参数，需要 Z.ai 侧补画像才能实现。

## 语义与边界

- **API Key 有两个来源**：插件设置里的值优先，为空时回退到供应商配置里已有的 Key（这样用户可以完全不把 Key 交给插件）。两者都没有时插件什么都不写，只报告该怎么做。
- **归属标记不可靠**：插件会在自己写的模型上留 `zcode.plugin = "deepseek"`，但 ZCode 重写配置时会把它和每档参数一起抹掉。所以判定主要靠「有档位名却没有每档参数」这个特征，标记只作辅助。
- **只接管一个供应商**：按 baseURL / 名称 / 供应商 id / 模型 id 判断哪些是「DeepSeek 的」，优先接管插件管理过的那个（避免在候选之间跳来跳去），其余只在报告里列出、不做改动。
- **插件的改动要「下一次启动」才可见**：ZCode 在启动时读供应商/模型，插件在会话开始后才写配置。所以第一次重启只让插件写完，第二次重启界面才更新。用户说「更新后重启了但模型没变」时，先读 `~/.zcode/v2/config.json` 确认插件是否已经写入（有 `config.json.deepseek-plugin.bak` 就说明写过），已写入就让用户再重启一次。
- **幂等**：重复运行不会重复写入；没有变更时连文件都不写。
- **不覆盖用户配置**：已有完整档位的模型默认跳过（状态里标为「用户配置」），需要覆盖时显式传 `overwrite_levels: true`。
- **拉不到模型列表就什么都不写**：避免留下「有供应商但没模型」的半成品。
- **每次写入前备份**：`config.json.deepseek-plugin.bak`。

## 常见问题

0. **用户说「填了 Key 点保存配置没反应」** — 先别急着排查：保存成功时 UI **没有任何成功提示**，这属于正常表现。真正的判断依据是 `~/.zcode/cli/config.json` 里的 `plugins.options[<pluginId>]`（pluginId 形如 `deepseek@<marketplace>`）是否已包含 `api_key`。已写入就说明保存成功，直接看下一步；没写入再查保存失败的原因。
1. **插件设置里的 Key 字段显示「该值需要安全存储接入后才能配置」、根本没法输入** — 该字段被标了 `sensitive: true`，而当前版本的安全存储尚未接入：UI 会**无条件**把这类字段渲染成这条提示、不给输入框。这不是配置错误，改法是从 manifest 的 `userConfig.<字段>` 里删掉 `"sensitive": true`（本仓库 0.1.1 起已移除）。若用户已在别处配过 Key，也可以不改 manifest，直接让插件走回退路径。
2. **模型列表里有两个 DeepSeek 供应商** — 插件只接管一个（优先接管它自己管理过的），另一个是用户自己建的，插件不会动它。建议用户删掉不用的那个，避免混淆。
3. **填了 Key，模型没出现** — 配置在 ZCode 启动时读取，需要重启（或新开会话）。也可先 `deepseek_status` 确认是否已写入。
2. **档位名有，但选「低」没有任何效果** — 这是最典型的坑：ZCode 保存配置时会把模型归一化成 `{enabled, variants, defaultVariant}` 并**丢掉每档的参数**，档位名还在、但选中后不会发出 `effort`。`deepseek_status` 里这类模型会标成 `[档位缺参数，sync 可补全]`，调一次 `deepseek_sync` 即可补全（不需要 `overwrite_levels`）。
3. **档位还是只有「关/高/最高」** — 该模型的档位是用户自己配的完整配置，默认不覆盖。先 `deepseek_sync {dry_run: true}` 预览，再 `deepseek_sync {overwrite_levels: true}` 落盘。
4. **想加档位**（`medium` / `xhigh` / `ultra`，DeepSeek 端点都认）— 在 `THINKING_LEVELS` 里照着加一行，然后重新 `deepseek_sync`。注意 ZCode 界面只内置了 off/low/high/xhigh/max 的中文标签，其它档位名会显示英文原名。
5. **报「拉取模型列表失败」** — 说明 `/models` 请求失败（Key 无效、网络或端点不对）。此时插件**不做任何写入**；修好后重新 sync 即可。
6. **端点返回的模型 id 和配置里的不一样**（如 `deepseek-flash` vs `deepseek-v4-flash`）— 它们是同一个模型的别名，由 `MODEL_ALIASES` 去重，不会在列表里出现两条。
7. **卸载后供应商还在** — 供应商是写进 ZCode 配置的，与插件生命周期无关。去「设置 → 模型供应商」删掉 DeepSeek 条目，或从 `config.json` 的 `provider` 里删除对应 id。
