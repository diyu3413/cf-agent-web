# cf-agent-web

跑在 Cloudflare Workers 上的**网页版文件工作区 agent**：R2 是它的文件系统，D1 存索引和会话列表，每个会话一个 Durable Object，模型调用走你的 OpenAI 兼容网关（比如 [cf-llm-gateway](https://github.com/diyu3413/cf-llm-gateway)）。

它是一个"阉割版 agent"：没有终端、不能执行代码、没有 git —— 能做的事就是通过工具读写、编辑、检索工作区里的文本文件，以及给自己安排定时任务。适合笔记整理、文档批量改写、资料检索问答这类活。

前端零依赖手写 Material Design 3，与 cf-llm-gateway 的管理面板共用同一套设计令牌。

## 能力

| 工具 | 说明 |
|---|---|
| `workspace_list` / `workspace_read` / `workspace_write` | 列目录、读文件（长文件分页）、写文件 |
| `workspace_edit` | 精确替换：old_string 必须恰好命中一次；用 R2 的 `onlyIf` 条件写防并发覆盖 |
| `workspace_delete` | 批量删除 |
| `workspace_search` | 全文检索（D1 FTS5，中文按单字+二字组索引） |
| `schedule_task` | 定时唤醒：到点以系统消息把 agent 叫醒继续干活（DO alarm） |

- 对话实时流式输出（可休眠 WebSocket，断线重连不丢会话）
- WebSocket 不可用时自动退回 REST 整段模式
- 单轮工具调用上限（默认 12 次）防失控；上下文按字符预算自动裁剪最旧对话段
- 登录限速、会话 Cookie（HMAC）、路径规范化防穿越

## 免费额度怎么省的

- **文件正文只在 R2**（免费 10GB、百万级月操作）；D1 只存索引/元数据，行数极少 —— 2026-09 起 D1 免费版每天 10 万行读写是硬限额
- 聊天记录存在 DO 自带 SQLite，不占 D1 额度
- 前端单 HTML 文档（CSS/JS 内联），开页面只算 1 次请求
- 模型调用是唯一的外部子请求消耗，上限由"单轮工具次数"兜住

## 部署

前置：Node 20+，一个 Cloudflare 账号，一个 OpenAI 兼容网关（推荐配合 [cf-llm-gateway](https://github.com/diyu3413/cf-llm-gateway)）。

```bash
npm install

# 1. 创建资源
npx wrangler d1 create agent-web          # 把输出的 database_id 填进 wrangler.toml
npx wrangler r2 bucket create agent-workspace

# 2. 建表（远程）
npx wrangler d1 migrations apply DB --remote

# 3. 管理员密码
npx wrangler secret put admin_password

# 4. 部署
npx wrangler deploy
```

打开 `https://<你的域名>/`，用管理员密码登录，到「设置」页填网关地址和密钥，然后在「会话」页开工。

## 本地开发

```bash
npm run migrate:local      # 本地 D1 建表
npm run dev                # wrangler dev，本地 DO/D1/R2 全套模拟
node scripts/mock-gw.mjs   # 另开一个终端：脚本化假网关（:8999）
node scripts/smoke-dev.mjs # 全栈冒烟：登录/文件/WS 对话/定时任务
```

## 测试

```bash
npm test    # 单测 + agent 循环集成测试（Node 内置 SQLite 模拟 D1）+ UI 标签配对
```

## 架构速览

```
浏览器（单页 MD3）
  │  /api/* REST · /ws WebSocket
Worker（src/index.js）
  ├─ Durable Object「AgentSession」×每会话
  │    ├─ 消息历史（自带 SQLite）
  │    ├─ 工具循环（src/lib/agentloop.js，可独立测试）
  │    └─ alarm 定时任务
  ├─ D1：settings / sessions / files + files_fts
  ├─ R2：工作区文件正文
  └─ → OpenAI 兼容网关 /v1/chat/completions（流式 + tools）
```

## 边界（有意不做）

- 不执行代码/命令 —— 没有沙箱，模型只能"盲改"，靠工具结果自查
- 二进制文件不入索引、不可编辑（只能删除）
- 单文件建议 ≤ 2MB；超过 128KB 的文本不进全文索引（仍可读）
- 上下文超预算时丢弃最旧对话段，超长任务建议拆会话

MIT License. 设计令牌与组件样式同源于 cf-llm-gateway，两处拷贝需保持一致（`src/ui/tokens.js`）。

## 两种形态

本仓库是 agent 的**独立版**（自己一个 Worker，模型走你在设置里填的网关地址）。它还有第二种形态：作为**内嵌模块**合并进 [cf-llm-gateway](https://github.com/diyu3413/cf-llm-gateway) 的 Workers 部署（`src/agent/`），管理台左侧 rail 点「Agent」进入——模型调用直连网关调用链（`runChain`），模型列表和用量统计自动复用网关配置。

两边代码同步：在网关仓库跑 `npm run sync-agent`（本仓库 → 网关的 `src/agent/`；`lib/fetchchat.js` 和 `lib/features.js` 是网关侧的覆盖实现，同步不覆盖，两边保持同一签名 `buildFetchChat` / `agentFeatures`）。改本仓库代码后记得同步过去。
