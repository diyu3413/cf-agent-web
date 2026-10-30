#!/usr/bin/env node
// 假网关：给 wrangler dev 冒烟测试用的脚本化 OpenAI 兼容端点。
// 按对话内容决定下一步：没干过活就先调工具，干完就给最终回答。
// 用法：node scripts/mock-gw.mjs [端口=8999]

import { createServer } from 'node:http';

const port = Number(process.argv[2]) || 8999;

function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const e of events) res.write('data: ' + JSON.stringify(e) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

const chunk = (delta, finish = null, usage = null) => ({
  choices: [{ delta, finish_reason: finish, index: 0 }],
  ...(usage ? { usage } : {}),
});

// 思考增量 + 模拟缓存命中的 usage（让本地能验证思考块和会话 token 显示）
const USAGE = { prompt_tokens: 186, completion_tokens: 42, prompt_cache_hit_tokens: 128 };
const reasoning = (text) =>
  (text.match(/.{1,6}/gs) || []).map((part) => chunk({ reasoning_content: part }));

createServer((req, res) => {
  // Tavily 形状的搜索端点：给 web_search 工具本地联调用
  if (req.method === 'POST' && req.url.includes('/search')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let q = '';
      try {
        q = String(JSON.parse(body).query || '');
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          answer: 'Cloudflare 的 agent 生态近期更新了 Agents SDK 与沙箱能力。',
          results: [
            { title: 'Cloudflare Agents 官方博客', url: 'https://example.com/article', content: 'Cloudflare OS 与 Agents SDK 的最新动态，Workers 免费版即可运行轻量 agent。' },
            { title: '另一条结果', url: 'https://example.com/second', content: '关于 D1 与 R2 在 agent 工作区中的角色说明。' },
          ],
          query: q,
        })
      );
    });
    return;
  }
  // web_fetch 演示用的假文章页
  if (req.url.includes('/article')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<html><head><title>演示文章</title><style>body{color:red}</style></head><body>' +
        '<h1>Cloudflare Agent 动态</h1><p>这是给 web_fetch 演示用的正文段落，应该被抓取为纯文本。</p>' +
        '<script>console.log("这段脚本内容应当被剥掉")</script></body></html>'
    );
    return;
  }
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {}
    // 注意：只能看「最后一条用户消息」来分流。系统提示里天然含有"定时/工具"等词，
    // 拿整个 messages JSON 做关键词嗅探会被它带偏。
    const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
    const userText = lastUser ? String(lastUser.content || '') : '';
    // 本轮内是否已有工具结果：只看最后一条 user 消息之后的部分，
    // 会话级别的历史 tool 消息不能算数（否则第二轮永远拿不到工具）。
    const msgs = body.messages || [];
    const lastUserIdx = msgs.map((m) => m.role).lastIndexOf('user');
    const afterLastUser = msgs.slice(lastUserIdx + 1);
    const hasToolResult = afterLastUser.some((m) => m.role === 'tool');
    // 联网链路的分轮标记：调过 web_search 且有结果 → 该 web_fetch；调过 web_fetch 且有结果 → 该总结
    const calledSearch = afterLastUser.some((m) => m.role === 'assistant' && JSON.stringify(m.tool_calls || '').includes('web_search'));
    const calledFetch = afterLastUser.some((m) => m.role === 'assistant' && JSON.stringify(m.tool_calls || '').includes('web_fetch'));
    const hasWebSearchResult = calledSearch && hasToolResult && !calledFetch;
    const hasWebFetchResult = calledFetch && hasToolResult;
    const wantsSchedule = userText.includes('提醒') || userText.includes('定时');
    // alarm 续跑回合（"[定时任务] …"）必须直接收尾，不然假网关会让 agent
    // 每 60 秒给自己排一个新任务，无限自循环。
    const isAlarmFollowup = userText.startsWith('[定时任务]');
    if (isAlarmFollowup) {
      sse(res, [chunk({ content: '定时任务完成：' + userText.replace('[定时任务]', '').trim() + '。' }), chunk({}, 'stop', USAGE)]);
      return;
    }

    // 联网剧本：让假上游演示 web_search → web_fetch → markdown 总结的完整链路
    if ((userText.includes('搜索') || userText.includes('联网')) && !hasToolResult) {
      sse(res, [
        ...reasoning('用户要最新信息，我需要联网搜索。'),
        chunk({ content: '我先联网搜一下。' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_search', function: { name: 'web_search', arguments: JSON.stringify({ query: 'cloudflare agent 最新动态' }) } }] }),
        chunk({}, 'tool_calls'),
      ]);
      return;
    }
    if (hasWebSearchResult) {
      sse(res, [
        chunk({ content: '搜到了，我打开第一条看全文。' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_fetch', function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'http://127.0.0.1:8999/article' }) } }] }),
        chunk({}, 'tool_calls'),
      ]);
      return;
    }
    if (hasWebFetchResult) {
      sse(res, [
        ...reasoning('拿到搜索结果和网页正文了，用 markdown 总结给用户。'),
        chunk({ content: '## 联网结果\n\n根据搜索和抓取：\n\n- **要点一**：Cloudflare 的 agent 生态在持续更新\n- **要点二**： Workers 免费版即可运行\n\n> 摘自搜索结果的第一条。\n\n```json\n{"source": "web", "confidence": "high"}\n```\n\n完整内容见 [原文链接](https://example.com/article)。' }),
        chunk({}, 'stop', USAGE),
      ]);
      return;
    }

    if (wantsSchedule && !hasToolResult) {
      sse(res, [
        ...reasoning('用户要定时提醒，我安排 schedule_task，一分钟后再叫醒自己。'),
        chunk({ tool_calls: [{ index: 0, id: 'call_sched', function: { name: 'schedule_task', arguments: JSON.stringify({ delay_minutes: 1, instruction: '提醒用户喝水' }) } }] }),
        chunk({}, 'tool_calls'),
      ]);
      return;
    }
    if (!hasToolResult) {
      sse(res, [
        ...reasoning('用户让我创建文件，我直接调用 workspace_write 写入工作区。'),
        chunk({ content: '好的，我来创建文件。' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_write', function: { name: 'workspace_write', arguments: JSON.stringify({ path: 'agent.md', content: '# 由 agent 创建\n\n这是冒烟测试写入的内容。' }) } }] }),
        chunk({}, 'tool_calls'),
      ]);
      return;
    }
    sse(res, [
      chunk({ content: '文件' }),
      chunk({ content: '已经创建好了，内容是「冒烟测试」。' }),
      chunk({}, 'stop', USAGE),
    ]);
  });
}).listen(port, () => console.log('mock gateway on :' + port));
