#!/usr/bin/env node
// 对 wrangler dev 实例做全栈冒烟：登录 → 配置 → 文件 CRUD/检索 → WebSocket 对话
// （真实 DO + 工具循环 + 假网关）→ 定时任务（DO alarm）。
// 前置：1) node scripts/mock-gw.mjs  2) wrangler dev（8787 端口）
// 用法：node scripts/smoke-dev.mjs

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8787';
const PW = process.env.SMOKE_PW || 'dev123';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''));
  }
};

let cookie = '';
let sessionToken = '';
async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    cookie = setCookie.split(';')[0];
    const eq = cookie.indexOf('=');
    if (eq > 0) sessionToken = cookie.slice(eq + 1);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

async function wsChat(sessionId, text, { timeoutMs = 60_000 } = {}) {
  // Node 22+ 自带 WebSocket 客户端，但它不会自动带 Cookie，
  // 所以走 ?t= 令牌（浏览器端没有这个限制，仍然自动用 Cookie）
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws?session=' + sessionId + '&t=' + encodeURIComponent(sessionToken));
  const events = [];
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('WS 超时，收到事件：' + JSON.stringify(events.map((e) => e.type))));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'user_message', text }));
    ws.onmessage = (ev) => {
      let e = null;
      try { e = JSON.parse(ev.data); } catch { return; }
      events.push(e);
      if (e.type === 'turn_done') {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(events);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('WS 连接失败'));
    };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n[1] 健康与登录');
  const health = await api('/healthz');
  ok('healthz', health.status === 200 && health.data.ok);
  const badLogin = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) });
  ok('错误密码被拒', badLogin.status === 401);
  const login = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: PW }) });
  ok('登录成功', login.status === 200 && cookie.includes('='), JSON.stringify(login.data));
  const noAuth = await fetch(BASE + '/api/files');
  ok('未登录访问被拒', noAuth.status === 401);

  console.log('\n[2] 设置');
  const saveSet = await api('/api/settings', {
    method: 'POST',
    body: JSON.stringify({ settings: { gatewayBaseUrl: 'http://127.0.0.1:8999', gatewayKey: 'sk-test-12345678', model: 'auto' } }),
  });
  ok('保存设置', saveSet.status === 200 && saveSet.data.settings.gatewayBaseUrl === 'http://127.0.0.1:8999');
  ok('密钥回传是掩码', saveSet.data.settings.keyMask.includes('****'));

  console.log('\n[3] 文件 CRUD + 检索');
  const put = await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: 'hello.md', content: '# 注意事项\n\n这是冒烟测试文件。' }) });
  ok('写入文件', put.status === 200 && put.data.ok, JSON.stringify(put.data));
  const files = await api('/api/files');
  ok('列表可见', files.data.files.some((f) => f.path === 'hello.md'));
  const search = await api('/api/search?q=' + encodeURIComponent('注意 测试'));
  ok('FTS 检索命中', search.data.ok && search.data.count === 1, JSON.stringify(search.data));
  const traversal = await api('/api/file?path=' + encodeURIComponent('../evil'));
  ok('穿越路径被拒', traversal.data.ok === false);

  console.log('\n[4] WebSocket 对话（DO + 工具循环 + 假网关）');
  const sess = await api('/api/sessions', { method: 'POST', body: JSON.stringify({}) });
  const sid = sess.data.id;
  ok('创建会话', Boolean(sid));
  const events = await wsChat(sid, '请创建一个文件记录冒烟测试结果');
  ok('收到 busy 事件', events.some((e) => e.type === 'busy' && e.on));
  ok('收到工具调用', events.some((e) => e.type === 'tool_start' && e.name === 'workspace_write'));
  ok('工具执行成功', events.some((e) => e.type === 'tool_end' && e.ok));
  ok('收到流式增量', events.filter((e) => e.type === 'delta').length >= 1);
  ok('回合完成', events.some((e) => e.type === 'turn_done' && e.ok));
  const files2 = await api('/api/files');
  ok('agent 真的写入了文件', files2.data.files.some((f) => f.path === 'agent.md'), JSON.stringify(files2.data.files.map((f) => f.path)));
  const searchAgent = await api('/api/search?q=' + encodeURIComponent('冒烟'));
  ok('agent 写的文件进了索引', searchAgent.data.ok && searchAgent.data.count >= 1);

  console.log('\n[5] 定时任务（DO alarm）');
  const events2 = await wsChat(sid, '一分钟后提醒我');
  ok('schedule_task 执行成功', events2.some((e) => e.type === 'tool_end' && e.ok && e.name === 'schedule_task'));
  const tasks = await api('/api/sessions/' + sid + '/tasks');
  ok('任务挂起可见', tasks.data.tasks.length === 1, JSON.stringify(tasks.data));
  console.log('  … 轮询等 alarm 触发（本地模拟器有几十秒调度延迟，属正常）…');
  let cleared = false;
  for (let i = 0; i < 18; i++) {
    await sleep(5_000);
    const t = await api('/api/sessions/' + sid + '/tasks');
    if (t.data.tasks.length === 0) {
      cleared = true;
      break;
    }
  }
  ok('alarm 触发后任务清空', cleared);
  const msgs = await api('/api/sessions/' + sid + '/messages');
  const lastAssistant = [...(msgs.data.messages || [])].reverse().find((m) => m.role === 'assistant' && m.content);
  ok('定时回合真的跑过并落库', Boolean(lastAssistant) && (msgs.data.messages.some((m) => m.content && m.content.includes('[定时任务]'))), lastAssistant && lastAssistant.content);

  console.log('\n[6] 会话管理');
  const sessions = await api('/api/sessions');
  ok('会话列表有标题', (sessions.data.sessions || []).some((s) => s.id === sid && s.title));
  const del = await api('/api/sessions/' + sid, { method: 'DELETE' });
  ok('删除会话', del.status === 200);
  const sessions2 = await api('/api/sessions');
  ok('列表里没了', !(sessions2.data.sessions || []).some((s) => s.id === sid));

  console.log('\n' + (fail ? '❌' : '✅') + ' 冒烟通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('冒烟中断：', e.message);
  process.exit(1);
});
