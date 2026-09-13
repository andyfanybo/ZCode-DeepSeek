# ZCode-DeepSeek

一个 ZCode 插件市集，目前只含一个插件：[`deepseek-plugin`](./deepseek-plugin) —— 只填一个 API Key，自动把 DeepSeek 供应商、模型列表和每个模型的思考档位（关/低/高/最高）写进 ZCode 配置。

## 用户怎么安装

实际界面路径（跟着点即可）：

1. 打开 ZCode 主页面 → 左上角 **插件市场**
2. 右上角 **创建**（有的入口显示为「新建」）→ 在弹出的输入框里填本仓库地址：

   ```
   andyfanybo/ZCode-DeepSeek
   ```

   完整的 GitHub 链接也行：

   ```
   https://github.com/andyfanybo/ZCode-DeepSeek
   ```

   想锁定版本就带 ref（取最后一个 `#` 或 `@` 之后的部分作为 Git ref）：

   ```
   andyfanybo/ZCode-DeepSeek#v0.1.3
   ```

   > 输入框的解析规则（源码 `parseMarketplaceSourceInput`）：`http(s)://` 开头的 GitHub 链接会被转成 git 拉取；`owner/repo` 这种简写走 GitHub 仓库源；也支持 Git URL、本地目录、`.json` 文件。填错会直接报 `Unsupported marketplace source`。

3. 回到插件市场首页，切到 **个人** 分区（你自己添加的市场源都在这里；官方源在 **公开** 分区）→ 找到 **deepseek** → 点 **安装**
4. 点插件名称进入**高级信息**，配 **DeepSeek API Key**（在 https://platform.deepseek.com 生成），两种方式任选其一：
   - 填在 `DeepSeek API Key` 字段后点 **保存配置**（明文存在 ZCode 的插件配置里）；
   - 或**留空**，改为在「设置 → 模型供应商」的 DeepSeek 供应商里填 Key，插件会复用它、不另存副本。

   > 点「保存配置」后界面**没有成功提示**，看起来像没反应——这是正常表现，值已经写进 `~/.zcode/cli/config.json` 的 `plugins.options`。
5. **重启 ZCode** —— 配置在启动时读取，重启后在「设置 → 模型供应商」能看到 DeepSeek 及其模型，模型下拉的思考档位出现 `关/低/高/最高`

之后每次会话启动，插件会自愈一次（ZCode 保存配置时可能抹掉每档参数，插件会补回来）。

想更新插件版本：在「个人」分区里对插件执行更新，或对市场源点「刷新该市场」。

## 环境要求

- **需要 Node ≥ 18 在 PATH 上**：插件的 MCP 服务器用 `node` 启动（manifest 里 `command: "node"`），因为自建市集的插件不会被运行时自动补全启动命令。你的机器上如果有疑虑，先跑 `node -v` 确认。
- 平台的其它部分（Windows / macOS / Linux）与架构无关：`dist/mcp/server.js` 是纯 Node ESM，零依赖。

## 仓库结构

```
.
├── marketplace.json          # 市集清单（ZCode 拉取的就是它）
└── deepseek-plugin/          # 插件本体
    ├── .zcode-plugin/plugin.json
    ├── dist/mcp/server.js
    ├── commands/  skills/  scripts/  README.md
```

市集清单里的 `plugins[].source` 是**相对本仓库根目录的路径**（`"deepseek-plugin"`）——ZCode 要求它落在市集根目录内，所以不要写绝对路径。

## 维护

- 改插件后，**两处版本号要一起改**：`marketplace.json` 的 `plugins[].version` 和 `deepseek-plugin/.zcode-plugin/plugin.json` 的 `version`。ZCode 靠版本号判断更新。
- 发布时打 tag（`git tag v0.1.0 && git push --tags`），用户就能用 `#v0.1.0` 锁定版本。
- 想换成 zip/CDN 分发，就把 `source` 改成 `{"source":"url","type":"zip","url":"https://...","sha256":"...","path":"deepseek-plugin"}`（官方在用这种形态）。

## 安全提示

这个插件会**修改用户的 ZCode 配置** `~/.zcode/v2/config.json`：新增/更新一个 DeepSeek 供应商、给它写模型与思考档位、并在插件字段填了 Key 时写入 `options.apiKey`（明文，与 ZCode 自身保存 provider key 的方式一致）。它只增不改（默认不覆盖已有的档位配置），每次写入前会备份成 `config.json.deepseek-plugin.bak`。

关于 API Key 的存放：填在插件里时，值明文保存在 ZCode 的插件配置（`~/.zcode/cli/config.json` 的 `plugins.options`）；也可以让插件字段留空，改为在「设置 → 模型供应商」里维护 Key，插件只复用、不另存副本。当前版本没法用 `sensitive: true` 加密该字段——标了 `sensitive` 的字段 UI 会拒绝编辑（提示「该值需要安全存储接入后才能配置」）。

卸载插件后供应商不会自动消失，需要在「设置 → 模型供应商」里手动删除。
