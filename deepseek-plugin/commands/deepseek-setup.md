---
description: 配置或重新同步 DeepSeek 供应商（模型与思考档位）
argument-hint: "[可选：overwrite 表示覆盖已有档位]"
skills: deepseek
---

用 `deepseek` 技能完成 DeepSeek 集成：

1. 先调用 `mcp__deepseek__deepseek_status` 看当前状态；
2. 如果提示 API Key 未配置，告诉用户两条路任选其一：a) 在「插件市场 → 个人 → deepseek → 高级信息」里填 `DeepSeek API Key` 并点「保存配置」（保存后界面无提示属正常，值已写入）；b) 留空，改为在「设置 → 模型供应商」的 DeepSeek 供应商里填 Key（插件会复用、不另存副本）。之后都要**重启 ZCode**；
3. 用户要求刷新模型或档位时，先 `deepseek_sync` 带 `dry_run: true` 预览，把将要写入的变更讲清楚，再询问是否落盘；
4. 只有用户明确要求（或参数里出现 `overwrite`）时才传 `overwrite_levels: true`；
5. 汇报时只说明写了哪些模型与档位，**不要输出任何密钥内容**。

补充说明：写入后需要重启 ZCode（或新开会话）才会加载新的供应商、模型与档位。

$ARGUMENTS
