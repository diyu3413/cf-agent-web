// 集成测试：真实的工作区工具（R2/D1）+ 脚本化的假网关，把「提问 → 工具调用 →
// 文件变更 → 最终回答」整条链在 Node 里走通。
// R2/D1 用内存桩：D1 桩直接包 Node 内置 SQLite（含 FTS5），语义和真 D1 一致。
// 运行：node test/agent.mjs

import { DatabaseSync } from 'node:sqlite';
import { runAgentTurn } from '../src/lib/agentloop.js';
import { wsList, wsRead, wsWrite, wsEdit, wsDelete, wsSearch } from '../src/lib/workspace.js';
import { getSettings, saveSettings } from '../src/lib/settings.js';

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

// ---------- 内存桩 ----------

class MemR2 {
  constructor() {
    this.m = new Map(); // key -> { text, etag }
    this.n = 0;
  }
  async get(key) {
    const v = this.m.get(key);
    if (!v) return null;
    return {
      etag: v.etag,
      text: async () => v.text,
      body: null,
    };
  }
  async put(key, value, opts) {
    this.n++;
    const cur = this.m.get(key);
    if (opts && opts.onlyIf) {
      if (!cur || cur.etag !== opts.onlyIf.etag) return null; // 条件不满足，与真实 R2 一致返回 null
    }
    const etag = 'e' + ++this.n;
    this.m.set(key, { text: String(value), etag });
    return { etag };
  }
  async delete(keys) {
    for (const k of [].concat(keys)) this.m.delete(k);
  }
  async list({ prefix = '', cursor, limit = 100 } = {}) {
    const all = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = all.slice(start, start + limit);
    const truncated = start + limit < all.length;
    return {
      objects: page.map((key) => ({ key, size: this.m.get(key).text.length, uploaded: new Date() })),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
    };
  }
}

class MemD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    return {
      bind: (...args) => ({
        all: async () => ({ results: stmt.all(...args) }),
        run: async () => stmt.run(...args),
        first: async () => stmt.get(...args),
      }),
      all: async () => ({ results: stmt.all() }),
      run: async () => stmt.run(),
    };
  }
  async batch(stmts) {
    for (const s of stmts) await s.run();
    return [];
  }
  exec(sql) {
    this.db.exec(sql);
  }
}

// 假网关：按脚本依次吐 SSE 响应，记录收到的请求体。
function fakeGateway(script) {
  const enc = new TextEncoder();
  const calls = [];
  let i = 0;
  return {
    calls,
    fetchChat: async ({ messages, tools, onDelta, onReasoning }) => {
      calls.push({ messages: JSON.parse(JSON.stringify(messages)), tools: tools || null });
      const step = script[Math.min(i, script.length - 1)];
      i++;
      const lines = [];
      if (step.reasoning) {
        for (const part of step.reasoning.match(/.{1,4}/gs) || []) {
          lines.push('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: part } }] }));
        }
      }
      if (step.content) {
        for (const part of step.content.match(/.{1,3}/gs) || []) {
          lines.push('data: ' + JSON.stringify({ choices: [{ delta: { content: part } }] }));
        }
      }
      for (const tc of step.toolCalls || []) {
        lines.push(
          'data: ' +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, id: tc.id, function: { name: tc.name, arguments: JSON.stringify(tc.args) } }],
                  },
                },
              ],
            })
        );
      }
      const finish = 'data: ' + JSON.stringify({
        choices: [{ delta: {}, finish_reason: step.toolCalls && step.toolCalls.length ? 'tool_calls' : 'stop' }],
        ...(step.usage ? { usage: step.usage } : {}),
      });
      lines.push(finish);
      lines.push('data: [DONE]');
      const body = new ReadableStream({
        start(c) {
          for (const l of lines) c.enqueue(enc.encode(l + '\n'));
          c.close();
        },
      });
      // 复用真的 SSE 解析，保证测试路径和生产一致
      const { consumeOpenAIStream } = await import('../src/lib/sse.js');
      return consumeOpenAIStream(body, { onDelta, onReasoning });
    },
  };
}

async function freshDb() {
  const db = new MemD1();
  db.exec(`CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at INTEGER, updated_at INTEGER)`);
  db.exec(`CREATE TABLE files (path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, is_text INTEGER)`);
  db.exec(`CREATE VIRTUAL TABLE files_fts USING fts5(path UNINDEXED, content, tokenize='unicode61 remove_diacritics 2')`);
  return db;
}

// ---------- 工作区工具 ----------

console.log('\n[1] 工作区 CRUD');
const r2 = new MemR2();
const db = await freshDb();

{
  const w = await wsWrite(r2, db, 'notes/待办.md', '# 待办\n\n- 给花园浇水\n- 写周报', 100000);
  ok('写入成功', w.ok && w.path === 'notes/待办.md');
  const r = await wsRead(r2, 'notes/待办.md');
  ok('读回一致', r.ok && r.content.includes('浇水'));
  const l = await wsList(r2);
  ok('列表有文件', l.count === 1 && l.files[0].path === 'notes/待办.md');

  const e = await wsEdit(r2, db, 'notes/待办.md', '写周报', '写周报并提交');
  ok('编辑成功且带摘要', e.ok && e.change.includes('第 4 行'), JSON.stringify(e));
  const r2r = await wsRead(r2, 'notes/待办.md');
  ok('编辑生效', r2r.content.includes('写周报并提交'));

  // 造一个双命中的场景（用独立文件，别污染待办文件的检索测试数据）
  await wsWrite(r2, db, 'tmp/dup.txt', 'AAA 目标词 BBB\nCCC 目标词 DDD', 100000);
  const dup = await wsEdit(r2, db, 'tmp/dup.txt', '目标词', 'X');
  ok('多命中拒绝', !dup.ok && dup.error.includes('命中了 2 处'), JSON.stringify(dup));
  const miss = await wsEdit(r2, db, 'notes/待办.md', '不存在的原文', 'X');
  ok('未命中拒绝', !miss.ok && miss.error.includes('没有命中'));

  const s = await wsSearch(db, '浇水');
  ok('FTS 检索命中', s.ok && s.count === 1 && s.hits[0].path === 'notes/待办.md', JSON.stringify(s));
  const s2 = await wsSearch(db, '浇水 周报');
  ok('多词 AND 检索', s2.ok && s2.count === 1);
  const s3 = await wsSearch(db, '不存在的词组');
  ok('检索无命中也 ok', s3.ok && s3.count === 0);

  const bad = await wsWrite(r2, db, '../escape', 'x', 100000);
  ok('穿越路径拒绝', !bad.ok);
  const overwrite = await wsWrite(r2, db, 'notes/待办.md', '整体覆盖', 100000);
  ok('整体覆盖成功', overwrite.ok);
  const afterOverwrite = await wsSearch(db, '浇水');
  ok('覆盖后旧内容不再命中', afterOverwrite.ok && afterOverwrite.count === 0);

  const del = await wsDelete(r2, db, ['notes/待办.md']);
  ok('删除成功', del.ok && (await wsRead(r2, 'notes/待办.md')).ok === false);
  const afterDel = await wsSearch(db, '整体覆盖');
  ok('删除后索引同步清掉', afterDel.ok && afterDel.count === 0);
}

// ---------- etag 并发保护 ----------

console.log('\n[2] onlyIf 并发保护');
{
  const r2b = new MemR2();
  const dbb = await freshDb();
  await wsWrite(r2b, dbb, 'a.txt', 'hello world', 100000);
  // 模拟另一个客户端抢先写入，令本地读到的 etag 过期
  const origGet = r2b.get.bind(r2b);
  let poisoned = false;
  r2b.get = async (key) => {
    const obj = await origGet(key);
    if (!poisoned && key === 'a.txt') {
      poisoned = true;
      await r2b.put('a.txt', '别人抢先改过 hello world', {}); // 丢一次写冲突 → 触发重试
      return await origGet(key); // 返回的还是旧 etag 的对象？不 —— 返回新对象，重试反而成功
    }
    return obj;
  };
  // 直接测冲突分支：拿到旧 etag 后再改 R2，然后用 onlyIf 写
  const obj = await origGet('a.txt');
  await r2b.put('a.txt', '并发修改', {});
  const conflict = await r2b.put('a.txt', '基于旧版本写', { onlyIf: { etag: obj.etag } });
  ok('过期 etag 写入被拒绝', conflict === null);
}

// ---------- settings ----------

console.log('\n[3] settings 存取');
{
  await saveSettings(db, { gatewayBaseUrl: 'https://gw.example.com', gatewayKey: 'sk-gw-abc', model: 'deepseek-chat', maxToolCalls: 5 });
  const s = await getSettings(db);
  ok('读回配置', s.gatewayBaseUrl === 'https://gw.example.com' && s.model === 'deepseek-chat');
  ok('数值字段还原', s.maxToolCalls === 5);
  ok('钳制生效', (await saveSettings(db, { maxToolCalls: 999 })).maxToolCalls === 40);
}

// ---------- agent 循环 ----------

console.log('\n[4] agent 工具循环（假网关）');
{
  const r2c = new MemR2();
  const dbc = await freshDb();
  const gw = fakeGateway([
    { reasoning: '用户想要日记，我先建文件再回复', content: '', toolCalls: [{ id: 'c1', name: 'workspace_write', args: { path: '日记.md', content: '今天天气不错。' } }] },
    { content: '已经把日记写好了。', toolCalls: [], usage: { prompt_tokens: 50, completion_tokens: 9, prompt_cache_hit_tokens: 20 } },
  ]);
  const events = [];
  const history = [];
  const result = await runAgentTurn({
    history,
    userText: '帮我写一篇日记',
    emit: (e) => events.push(e),
    execTool: async (name, args) => {
      const map = {
        workspace_write: () => wsWrite(r2c, dbc, args.path, args.content, 100000),
        workspace_read: () => wsRead(r2c, args.path, args.offset, 1000),
        workspace_search: () => wsSearch(dbc, args.query),
      };
      return (map[name] || (() => ({ ok: false, error: 'no tool' })))();
    },
    fetchChat: gw.fetchChat,
    maxToolCalls: 6,
    fileOverview: '',
  });
  ok('回合成功', result.ok, result.error || '');
  ok('文件真的写进去了', (await wsRead(r2c, '日记.md', 0, 100)).content.includes('天气'));
  ok('最终回答推送过增量', events.some((e) => e.type === 'delta' && e.text));
  ok('思考过程事件推送', events.some((e) => e.type === 'reasoning' && e.text && e.text.includes('日记')), JSON.stringify(events.filter((e) => e.type === 'reasoning')));
  ok('工具卡耗时上报', events.some((e) => e.type === 'tool_end' && typeof e.ms === 'number' && e.ms >= 0));
  ok('整轮 usage 累计（含缓存字段）', result.usageTotal && result.usageTotal.prompt === 50 && result.usageTotal.completion === 9 && result.usageTotal.cached === 20, JSON.stringify(result.usageTotal));
  ok('工具事件齐全', events.some((e) => e.type === 'tool_start' && e.name === 'workspace_write') && events.some((e) => e.type === 'tool_end' && e.ok));
  ok('历史完整（user+assistant(tool_calls)+tool+assistant）', history.length === 4 && history[2].role === 'tool', JSON.stringify(history.map((h) => h.role)));
  ok('思考过程随 assistant 消息持久化', String((history[1] && history[1].reasoning) || '').includes('日记'), JSON.stringify(history[1] && history[1].reasoning));
  ok('第二轮请求带上了工具结果', gw.calls[1].messages.some((m) => m.role === 'tool'));
  ok('系统提示在请求首位', gw.calls[0].messages[0].role === 'system');
}

console.log('\n[5] 上限收尾与错误路径');
{
  const r2d = new MemR2();
  const dbd = await freshDb();
  // 模型永远想调工具：到上限后必须强制收尾且不再给工具
  const gw = fakeGateway([{ content: '我再查一下', toolCalls: [{ id: 'x', name: 'workspace_list', args: {} }] }]);
  const events = [];
  const result = await runAgentTurn({
    history: [],
    userText: '列一下文件',
    emit: (e) => events.push(e),
    execTool: async () => wsList(r2d),
    fetchChat: gw.fetchChat,
    maxToolCalls: 3,
  });
  ok('收尾回合不再带 tools', gw.calls[gw.calls.length - 1].tools === null);
  ok('有 notice 事件', events.some((e) => e.type === 'notice' && e.text.includes('上限')));
  ok('回合最终成功', result.ok && result.iterations === 4, 'iterations=' + result.iterations);

  // 网关抛错 → 回合失败且有 error 事件
  const result2 = await runAgentTurn({
    history: [],
    userText: 'hi',
    emit: () => {},
    execTool: async () => ({ ok: true }),
    fetchChat: async () => {
      throw new Error('网关 403');
    },
  });
  ok('网关故障回合失败', !result2.ok && result2.error.includes('403'));
}

console.log('\n✅ 集成测试通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
