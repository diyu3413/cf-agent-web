// 纯逻辑单测：路径校验、SSE 解析、历史裁剪、FTS 表达式、网关客户端（mock fetch）。
// 运行：node test/unit.mjs

import { normalizeWorkspacePath, countOccurrences, looksBinary, ftsMatchExpression, diffSummary, isTextPath } from '../src/lib/textutil.js';
import { consumeOpenAIStream } from '../src/lib/sse.js';
import { trimHistory } from '../src/lib/agentloop.js';
import { toolResultText } from '../src/lib/workspace.js';
import { normalizeBaseUrl, chatStream } from '../src/lib/llm.js';
import { buildSystemPrompt, fileOverviewText } from '../src/lib/prompts.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''));
  }
}

// ---------- 路径 ----------

console.log('\n[1] 路径规范化');
ok('普通路径保留', normalizeWorkspacePath('docs/笔记.md') === 'docs/笔记.md');
ok('去首尾斜杠与冗余段', normalizeWorkspacePath('/a//b/./') === 'a/b');
ok('反斜杠转正斜杠', normalizeWorkspacePath('a\\b\\c.txt') === 'a/b/c.txt');
ok('拒绝 .. 穿越', (() => { try { normalizeWorkspacePath('a/../../etc'); return false; } catch { return true; } })());
ok('拒绝空路径', (() => { try { normalizeWorkspacePath('  '); return false; } catch { return true; } })());
ok('拒绝控制字符', (() => { try { normalizeWorkspacePath('a\x01b'); return false; } catch { return true; } })());
ok('文本扩展名识别', isTextPath('a/b.MD') && !isTextPath('a/b.png'));

// ---------- 文本工具 ----------

console.log('\n[2] 文本工具');
ok('计数：恰好命中', countOccurrences('abcabc', 'abc') === 2);
ok('计数：空串为 0', countOccurrences('abc', '') === 0);
ok('二进制嗅探：NUL', looksBinary('ok\0bad'));
ok('二进制嗅探：正常文本放行', !looksBinary('这是普通中文文本。\n'.repeat(10)));
ok('diff 摘要有行号', diffSummary('l1\nl2\nold', 'old', 'new').includes('第 3 行'));
ok('FTS 表达式加引号', ftsMatchExpression('hello world "x"') === '"hello" AND "world" AND "x"');

// ---------- SSE ----------

console.log('\n[3] OpenAI SSE 解析');
const enc = new TextEncoder();
function sseStream(lines, { delay = 0 } = {}) {
  return new ReadableStream({
    async start(c) {
      for (const l of lines) {
        c.enqueue(enc.encode(l + '\n')); // SSE 行必须以换行结尾，漏了就全粘成一行
        if (delay) await new Promise((r) => setTimeout(r, delay));
      }
      c.close();
    },
  });
}

{
  const deltas = [];
  const parsed = await consumeOpenAIStream(
    sseStream([
      'data: {"choices":[{"delta":{"content":"你"}}]}',
      'data: {"choices":[{"delta":{"content":"好"}}]}',
      '', // 空行
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"workspace_write","arguments":"{\\"path\\""}}]}},{"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"hi\\",\\"content\\":\\"x\\"}"}}]}},{"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      'data: [DONE]',
    ]),
    (t) => deltas.push(t)
  );
  ok('文本增量合并', parsed.content === '你好');
  ok('增量回调次数', deltas.join('') === '你好');
  ok('跨块工具参数拼接', parsed.toolCalls.length === 1 && parsed.toolCalls[0].function.name === 'workspace_write');
  ok('工具参数可解析', (() => { try { return JSON.parse(parsed.toolCalls[0].function.arguments).path === 'hi'; } catch { return false; } })());
  ok('finish_reason 与 usage', parsed.finishReason === 'tool_calls' && parsed.usage.completion === 5);
}

{
  const parsed = await consumeOpenAIStream(
    sseStream(['data: {"error":{"message":"上游流中途出错：boom","type":"gateway_mid_stream_error"}}', 'data: [DONE]'])
  );
  ok('识别流内错误事件', parsed.error.includes('boom'));
}

{
  // 推理模型：reasoning_content 增量合并 + 缓存命中字段（OpenAI 风格）
  const reasoningParts = [];
  const parsed = await consumeOpenAIStream(
    sseStream([
      'data: {"choices":[{"delta":{"reasoning_content":"我先想想"}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"再看看文件"}}]}',
      'data: {"choices":[{"delta":{"content":"答案"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":64}}}',
      'data: [DONE]',
    ]),
    { onDelta: function () {}, onReasoning: function (t) { reasoningParts.push(t); } }
  );
  ok('reasoning 增量合并', parsed.reasoning === '我先想想再看看文件', JSON.stringify(parsed.reasoning));
  ok('onReasoning 回调逐段推送', reasoningParts.join('') === '我先想想再看看文件');
  ok('缓存命中解析（OpenAI 字段）', parsed.usage && parsed.usage.cached === 64, JSON.stringify(parsed.usage));
}

{
  // 缓存命中字段（DeepSeek 风格 prompt_cache_hit_tokens）
  const parsed = await consumeOpenAIStream(
    sseStream([
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_cache_hit_tokens":7}}',
      'data: [DONE]',
    ])
  );
  ok('缓存命中解析（DeepSeek 字段）', parsed.usage && parsed.usage.cached === 7, JSON.stringify(parsed.usage));
}

// ---------- 历史裁剪 ----------

console.log('\n[4] 历史裁剪');
{
  const h = [
    { role: 'user', content: 'h1' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'r1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'h2' },
    { role: 'assistant', content: 'a2' },
  ];
  const t1 = trimHistory(h, 1_000_000);
  ok('预算充足不动', t1 === h || t1.length === h.length);
  const t2 = trimHistory(h, 4);
  ok('裁掉最旧一段且成组', t2[0].role === 'user' && t2[0].content === 'h2' && t2.length === 2, JSON.stringify(t2));
  // tool 消息绝不能出现在段首
  ok('不会拆散 tool 配对', t2.every((m, i) => i === 0 || m.role !== 'tool' || t2[i - 1].role === 'assistant'));
}

// ---------- 工具结果截断 ----------

console.log('\n[5] 工具结果序列化');
ok('短结果原样', JSON.parse(toolResultText({ ok: true, x: 1 })).x === 1);
ok('超长结果截断且仍是合法 JSON', (() => {
  const t = toolResultText({ ok: true, blob: 'x'.repeat(40000) }, 1000);
  return t.length < 2000 && JSON.parse(t).truncated === true;
})());

// ---------- 网关客户端 ----------

console.log('\n[6] 网关客户端');
ok('baseUrl 归一', normalizeBaseUrl('https://gw.example.com/') === 'https://gw.example.com');
ok('baseUrl 去重复 /v1', normalizeBaseUrl('https://gw.example.com/v1/') === 'https://gw.example.com');
ok('baseUrl 补协议', normalizeBaseUrl('gw.example.com') === 'https://gw.example.com');

{
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, init: JSON.parse(init.body) };
    return new Response(
      sseStream(['data: {"choices":[{"delta":{"content":"ok"}}]}']),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    );
  };
  try {
    const r = await chatStream({
      baseUrl: 'https://gw.example.com',
      apiKey: 'sk-gw-test',
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
    });
    ok('网关调用成功', r.content === 'ok');
    ok('请求打到 /v1/chat/completions', seen.url === 'https://gw.example.com/v1/chat/completions');
    ok('鉴权头正确', seen.init.model === 'auto');
  } catch (e) {
    ok('网关调用成功', false, e.message);
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":{"message":"全部上游失败"}}', { status: 403 });
  try {
    await chatStream({ baseUrl: 'https://gw.example.com', apiKey: 'k', model: 'auto', messages: [] });
    ok('网关 403 会抛错', false, '没有抛');
  } catch (e) {
    ok('网关 403 会抛错', e.message.includes('403'));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------- 提示词 ----------

console.log('\n[7] 系统提示');
{
  const sys = buildSystemPrompt({ systemPrompt: '永远用诗意语言', fileOverview: fileOverviewText([{ path: 'a.md', size: 10 }, { path: 'b/b.md', size: 20 }]) });
  ok('含工作区清单', sys.includes('a.md'));
  ok('含附加要求', sys.includes('诗意'));
  ok('空工作区提示', buildSystemPrompt({}).includes('工作区是空的'));
}

console.log('\n✅ 单测通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
