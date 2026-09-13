# DeepSeek 插件 for ZCode

用户只填一个 API Key，插件自动把 **DeepSeek 供应商 + 模型列表 + 每个模型的思考档位**写进 ZCode 配置。

## 它解决什么问题

ZCode 本身已经认识 DeepSeek，但有两个坑：

1. **档位是写死的画像**：内置 catalog 对 DeepSeek 只定义了 `关/高/最高`，接口明明支持更多档位却点不到；
2. **供应商要手填**：模型 id、上下文窗口都得自己敲，端点自动发现模型的功能没有。

这个插件的做法：从 `GET /models` 拉模型列表，把模型 id 规范化成 ZCode 认识的写法，并为每个模型写入档位定义（默认 `关/低/高/最高`）。

> **实测更正（重要）**：写入配置只能改变**界面上列出哪些档位**，并**不能**决定每个档位实际发出什么参数。每档的参数由 ZCode 运行时按**模型 id** 匹配内置画像决定：
> - id 以 `deepseek-v4` 开头 → 深度档位画像，档位带 `effort` + `thinking` 预算（内置只有 `high`/`max`）；
> - 其它含 `deepseek` 的 id（如 `deepseek-flash`）→ 只有开关画像，**任何档位都不会发出 `effort`**。
>
> 所以「低」这一类内置画像里没有的档位，即使写进了配置、界面上也能选，选中后也不会发出参数。这一点无法靠插件绕过，需要 Z.ai 在画像里补上。（依据：真实请求日志——`deepseek-v4-flash` 的请求带 `effort=max`，而 `deepseek-flash` 选「低」的请求不带任何 `output_config`。）

## 目录结构

```
deepseek-plugin/
├── .zcode-plugin/plugin.json   # manifest：userConfig（API Key 输入框）+ MCP 服务器声明
├── dist/mcp/server.js          # 全部逻辑：MCP 服务器 + 幂等开通/同步（零依赖，免构建）
├── commands/deepseek-setup.md  # /deepseek-setup 命令
├── skills/deepseek/SKILL.md    # 让 agent 知道怎么查状态、怎么同步、怎么排障
├── scripts/test-client.mjs     # 不开 ZCode 的自测客户端
└── README.md
```

## 安装（三步）

1. **把插件加进 ZCode**（实际界面路径）：
   1. 打开 ZCode 主页面 → 左上角 **插件市场**
   2. 右上角 **创建**（有的入口显示为「新建」）→ 填本仓库地址 `andyfanybo/ZCode-DeepSeek`（完整链接 `https://github.com/andyfanybo/ZCode-DeepSeek` 也行；带 `#v0.1.2` 可锁版本）
   3. 回插件市场首页 → 切到 **个人** 分区（自建市场源都在这里，官方源在 **公开**）→ 找到 **deepseek** → 点 **安装**
   - 本地开发：第 2 步改成选本地目录，指向**含 `marketplace.json` 的仓库根**（`deepseek-marketplace/`），不是本插件目录——ZCode 加载的是市集清单，然后按清单里的相对路径找插件。
   > 插件注册表由应用自己管理（不在 `~/.zcode/cli/config.json` 这类可见文件里），所以不要手改文件来“安装”，走界面。
2. **填 API Key**（两种方式任选其一）：
   - **A. 填在插件里**：插件详情 → `DeepSeek API Key`。值经环境变量注入插件进程（`"DEEPSEEK_API_KEY": "${user_config.api_key}"`）。它会被 ZCode 存在插件配置 `~/.zcode/cli/config.json` 的 `plugins.options.deepseek.api_key`，**明文**。
   - **B. 不填，交给 ZCode 管**：留空即可。先在「设置 → 模型供应商」建一个 DeepSeek 供应商（Anthropic 格式、`https://api.deepseek.com/anthropic`）并填好 Key，插件会**复用这份 Key** 去拉模型列表，不再另存副本。`deepseek_status` 会显示 `可用 API Key 来源：供应商配置（插件不保存副本）`。

   > 点了「保存配置」界面**不会有成功提示**（按钮只在请求期间禁用，成功后既不弹窗也不变灰），所以看起来像「没反应」。值其实已经写进 `~/.zcode/cli/config.json` 的 `plugins.options.deepseek` 了；想确认就看那个文件，或重启后调 `deepseek_status`。

   > 为什么不用 `sensitive: true` 把这个字段做成密文？因为标了 `sensitive` 的字段在当前版本里**根本没法编辑**——UI 会无条件渲染成「该值需要安全存储接入后才能配置」而不给输入框（安全存储尚未接入）。所以这里用的是可编辑的普通文本框。
3. **重启 ZCode**：供应商列表在启动时读取。重启后在「设置 → 模型供应商」能看到 DeepSeek 及其模型，模型下拉的思考档位应出现 `关/低/高/最高`。

   > 如果模型选择器里有**两个** DeepSeek 供应商（比如你自己建过一个、插件又建了一个），认准带插件模型的那个：模型 id 为 `deepseek-flash` / `deepseek-v4-pro`、档位四档齐全的那个是插件管理的。另一个可以删掉。

启动时会自动同步一次（也可用 `/deepseek-setup` 或让 agent 调用 `deepseek_sync` 手动触发）。

## 分发与发布

### 用户怎么添加你的市集

主页面 → 左上角 **插件市场** → 右上角 **创建** → 填来源。输入框解析规则（源码 `parseMarketplaceSourceInput`）：`http(s)://` 开头的 GitHub 链接转成 git 拉取；`owner/repo` 简写走 GitHub 源；也支持 Git URL、本地目录、`.json` 文件；都不是则报 `Unsupported marketplace source`。添加后市场源出现在 **个人** 分区。市集清单放在仓库根的 `marketplace.json`（也认 `.claude-plugin/marketplace.json`）。

### 插件条目支持的 source 形态

从源码 `resolvePluginEntrySource` 读出来的，全部可用：

| 形态 | 含义 |
|---|---|
| `"deepseek-plugin"` | 字符串 = 相对市集根目录的路径（最省事，单仓库自包含）。路径会被做越界检查：指向市集目录之外的绝对路径只在本地目录市集里有效，发布到 GitHub 时必须用相对路径 |
| `{"source":"directory","path":"..."}` | 本地目录 |
| `{"source":"github","repo":"you/repo","path":"deepseek-plugin","ref":"v0.1.3","sha":"..."}` | 从 `https://github.com/<repo>.git` 拉取 |
| `{"source":"git","url":"...","ref":"...","sha":"..."}` | 任意 Git 仓库 |
| `{"source":"url","type":"zip","url":"https://...","sha256":"...","path":"..."}` | zip 包（官方就用这种） |

### 本仓库的市集清单

仓库根已经放好可直接使用的 `marketplace.json`，`plugins[].source` 是相对路径 `"deepseek-plugin"`。用户在「新建 → 从 GitHub 仓库」里填：

```
andyfanybo/ZCode-DeepSeek          # 跟随默认分支
andyfanybo/ZCode-DeepSeek#v0.1.3   # 锁定 tag（ref 取最后一个 # 或 @ 之后的部分）
```

清单字段取自官方 marketplace 的实际结构：`name` / `plugins[].name` / `plugins[].source` / `description` / `description_i18n` / `version` / `author` / `icon` / `category` / `keywords`。

### manifest 的启动命令：两种形态

`plugin.json` 里现在用的是**可移植写法**：

```json
"command": "node",
"args": ["${ZCODE_PLUGIN_ROOT}/dist/mcp/server.js"]
```

需要用户机器上有 Node ≥18（ZCode 自带 Node，但不一定在 PATH 上）。注意 `${user_config.*}` 这类敏感值只能出现在 `env` 里，放进 `command`/`args` 会被运行时拒绝——所以 `command` 只能是解释器，不能是启动脚本。

如果你只在自己机器上用、想彻底摆脱 Node 依赖，可以换成用 ZCode 自带的运行时启动：

```json
"command": "C:\\Program Files\\ZCode\\ZCode.exe",
"args": [
  "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs",
  "__zcode-plugin-host",
  "${ZCODE_PLUGIN_ROOT}/dist/mcp/server.js"
],
"env": { "ELECTRON_RUN_AS_NODE": "1", "DEEPSEEK_API_KEY": "${user_config.api_key}" }
```

**这个形态不要发布出去**：路径是机器相关的。运行时会自动改写 `command`/`args`（设成本机可执行文件 + 固定约定路径 `<plugin>/dist/mcp/server.js`），但**只对官方市集的插件生效**——`writeOfficialPluginRuntimeManifest` 由官方插件播种流程调用，并把插件 id 写成 `<name>@zcode-plugins-official`；自建市集的插件用你声明的原值。顺带说：插件入口放在 `<plugin>/dist/mcp/server.js` 正好是官方插件用的约定路径，将来被官方收录无需改结构。

### 发布到官方市集

没有自助入口：客户端里没有提交/发布插件的 UI，官方市集是 Z.ai 自己托管的 CDN 清单（`https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json`），只能联系 Z.ai 收录（应用内置的社区入口：飞书群 / Discord）。好处是一旦进去了，`command`/`args` 由运行时自动补全，不用你操心路径，而且插件会随应用预置。


## 它会写什么

写进 `~/.zcode/v2/config.json` 的 `provider.<id>`（`<id>` 优先复用你已有的 DeepSeek 供应商，否则新建 `deepseek`）：

| 字段 | 值 | 说明 |
|---|---|---|
| `kind` | `anthropic` | 走 Anthropic 格式端点 |
| `options.baseURL` | `https://api.deepseek.com/anthropic` | 已有值不覆盖 |
| `options.apiKey` | 插件里填的 Key | 只在插件字段填了值、且与现值不同时才写；留空则沿用供应商已有的 Key，不覆盖。日志里从不回显 |
| `options.apiKeyRequired` | `true` | 仅新建时设置 |
| `models.<id>.limit` | 如 `1000000 / 128000` | 来自 `MODEL_PRESETS` 表 |
| `models.<id>.modalities` | `text` 输入 | DeepSeek 是纯文本模型，声明 image/video 会在挂图时报错 |
| `models.<id>.reasoning` | `levels` + `providerOptionsByLevel` | 运行时读取的那一份 |
| `models.<id>.reasoningSpec` | 同上的补丁形态 | 兜底：某些版本只认这一种 |
| `models.<id>.zcode.plugin` | `deepseek` | 归属标记，用于识别「插件写的」。**不是永久有效的**：ZCode 重写模型条目时会把它一起抹掉（见下节），所以它只是尽力而为的信号，判定还依赖「有档位名却没有每档参数」这个特征 |

档位最终会被 ZCode 翻译成请求体里的 `output_config.effort` 与 `thinking`，例如 `低` → `{"thinking":{"type":"enabled","budget_tokens":1024},"output_config":{"effort":"low"}}`。

### 一个必须知道的行为：ZCode 会「归一化」模型，丢掉每档参数和归属标记

ZCode 保存供应商时会把模型改写成 `{"enabled": true, "variants": ["off","low","high","max"], "defaultVariant": "max"}` —— **`reasoning.levels`、`providerOptionsByLevel`、整个 `reasoningSpec`，以及 `zcode.plugin` 归属标记都会被清掉**。后果是：档位名还在（界面上「低」照样能选），但选中后不会发出任何 `effort`，等于空档位。

这是实测到的、且会**反复发生**：我在一次会话中写入正确档位，ZCode 随后重写配置文件，参数与标记全部消失（`providerOptionsByLevel=[] reasoningSpec=[] 插件标记=None`，只留下 `variants`）。所以插件每次会话启动同步一次不是多余的。

正因如此，判定不能只靠标记（它会消失），而要区分两种情况：

| 模型状态 | 插件动作 |
|---|---|
| 没有档位 | 补写完整档位（`补写档位`） |
| 有档位名但没有每档参数（被归一化过） | **补全参数**（`补全档位参数`） |
| 有完整档位 + `zcode.plugin` 标记 | 对齐到档位表（`刷新档位` / `无变化`） |
| 有完整档位 + 无标记（用户自己配的） | 不动（`未覆盖`），除非显式 `overwrite_levels` |

因此**每次会话启动同步一次是有意的**：ZCode 下次保存配置时可能又把参数抹掉，插件在下一个会话重新补上。`deepseek_status` 会把缺参数的模型标成 `[档位缺参数，sync 可补全]`。

## 定制

都在 `dist/mcp/server.js` 顶部一段里：

- **档位**：`THINKING_LEVELS`。默认四档 `off/low/high/max`；想加 `medium`/`xhigh`/`ultra` 照着加一行（DeepSeek 端点都认）。注意 ZCode 只内置了 `off/low/high/xhigh/max` 的中文标签，其它档位名会显示英文原名。
- **模型元数据**：`MODEL_PRESETS`（上下文窗口 / 最大输出）。`GET /models` 不返回这些值，所以要么补表，要么接受 `MODEL_PRESET_FALLBACK`。
- **供应商 id / 名称 / 端点**：`PROVIDER_ID_FALLBACK`、`PROVIDER_NAME`、`DEFAULT_BASE_URL`。

## 自测（不需要开 ZCode）

```bash
node scripts/test-client.mjs                             # 假 Key：验证握手、创建供应商、失败降级
DEEPSEEK_API_KEY=sk-xxx node scripts/test-client.mjs     # 真 Key：验证真实模型列表
node scripts/test-client.mjs --dry-run                   # 只预览，不落盘
```

测试始终操作**临时配置副本**（插件支持 `DEEPSEEK_PLUGIN_CONFIG` 指向别的文件），不会碰你真实的 `config.json`。

## 卸载

1. 在插件管理里禁用/删除插件；
2. 供应商不会跟着消失（它是写进 ZCode 配置的）。去「设置 → 模型供应商」删掉 DeepSeek 条目，或从 `config.json` 的 `provider` 里删掉对应 id；
3. 备份文件 `config.json.deepseek-plugin.bak` 可留可删。

## 已知限制与风险

- **写的是内部格式**：`config.json` 的 `provider` 结构没有公开契约，ZCode 版本升级后字段可能变化。脚本已做：只增不改（默认不覆盖已有档位）、拉不到模型列表就什么都不写（不留半配置状态）、每次写入前备份、原子替换（临时文件 + rename）。
- **每次启动都会同步一次**：这是「自愈」也是副作用——ZCode 可能在保存配置时抹掉每档参数，插件在下一个会话补回来（见上一节）。需要关闭就设 `DEEPSEEK_PLUGIN_AUTO_SYNC=0`（在 manifest 的 `env` 里加一项）。
- **已有模型的 `modalities` 不会被改写**：插件只补缺失字段。如果你之前把 DeepSeek 模型声明成了 `image/video` 输入，插件不会纠正（挂图仍会失败）；想修就删掉该模型条目重新同步，或手工改成 `["text"]`。
- **`关` 不是硬关闭**：ZCode 的 Anthropic 请求构造器只发 `thinking:{type:"enabled"}`，`disabled` 时它直接省略 thinking 参数。实测 DeepSeek 在这种情况下仍返回一个空的 thinking 块。
- **Key 的存储**：方式 A 会把 Key 明文存在 `~/.zcode/cli/config.json` 的 `plugins.options.deepseek.api_key`，并（因为填了值）写一份到供应商的 `options.apiKey`。不想让插件落副本就用方式 B（插件字段留空），Key 只存在于 ZCode 自己的供应商配置里。
- **插件进程启动在配置读取之后 → 插件的改动要「下一次启动」才可见**：ZCode 在**启动时**把供应商/模型读进内存，而插件是在**会话开始后**（MCP 服务器启动）才写配置的。所以「第一次重启」只让插件完成写入，「第二次重启」界面才会显示新供应商/新模型 id。实测确认：插件 15:36:09 把 `deepseek-flash` 迁移成 `deepseek-v4-flash` 并落盘，但界面仍是旧 id，再一次重启后才更新。判断依据永远看 `~/.zcode/v2/config.json`（插件每次写入都会留 `config.json.deepseek-plugin.bak` 作为写入前快照）。
- **API Key 有两个来源**：插件设置里的值优先；为空时回退到供应商配置里的 Key。两者都没有时插件不做任何事，`deepseek_status` 会提示该怎么补。

## 排障

| 现象 | 原因与处理 |
|---|---|
| 点「保存配置」没反应 | 正常：保存成功时 UI 没有成功提示（按钮只在请求期间禁用）。值已写入 `~/.zcode/cli/config.json` 的 `plugins.options.deepseek`；用 `deepseek_status` 或直接看该文件确认 |
| 模型列表里出现两个 DeepSeek 供应商 | 插件只接管一个：按 baseURL / 名称 / 供应商 id / 模型 id 匹配，优先接管插件管理过的那个，其余只在报告里列出、不做改动。把不用的那个在「设置 → 模型供应商」里删掉或改名即可 |
| 插件设置里 Key 字段显示「该值需要安全存储接入后才能配置」，无法输入 | 字段被标成了 `sensitive: true`，而当前版本的安全存储尚未接入，UI 无条件屏蔽这类字段。删掉 `sensitive` 即可（本仓库 0.1.1 起已移除） |
| 填了 Key 但模型没出现 | 配置在启动时读取，需要重启（或新开会话）。先 `deepseek_status` 确认是否已写入 |
| 档位选了「低」没效果 | 该模型的档位只有名字、没有每档参数（被 ZCode 归一化过）。调一次 `deepseek_sync` 即可补全，状态里会标 `[档位缺参数，sync 可补全]` |
| 报「拉取模型列表失败」 | `/models` 请求失败（Key 无效、网络或端点不对）。插件**不做任何写入**；修好后重新 sync |
| 端点返回的模型 id 与配置里不同（`deepseek-flash` vs `deepseek-v4-flash`） | 同一模型的别名，由 `MODEL_ALIASES` 去重，不会出现两条 |
