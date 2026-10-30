// 环境里没有无头浏览器，用一个最小 DOM 桩把前端跑一遍：
// 逐个标签页触发渲染，把生成的 HTML 抓出来做标签配对校验。
// 目的是挡住"某个视图少个 </div> 导致整页塌掉"这类只在浏览器里才暴露的问题。
// 手法与 cf-llm-gateway 的 test/ui.mjs 同源。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  → ' : ''));
  }
}

// ---------- 标签配对 ----------

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'use', 'stop']);
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;

function checkBalance(html) {
  const stack = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html))) {
    const raw = m[0];
    const tag = m[1].toLowerCase();
    const selfClosed = m[2] === '/';
    if (raw.startsWith('</')) {
      if (VOID.has(tag)) continue;
      let top = stack.pop();
      while (top && top !== tag) {
        if (!VOID.has(top)) return '未闭合的 <' + top + '>（遇到 </' + tag + '> 时）';
        top = stack.pop();
      }
      if (top !== tag) return '多余的 </' + tag + '>';
    } else if (!selfClosed && !VOID.has(tag)) {
      stack.push(tag);
    }
  }
  const left = stack.filter((t) => !VOID.has(t));
  return left.length ? '未闭合：' + left.join(',') : '';
}

// ---------- DOM 桩 ----------

const captured = [];
function makeEl(tag) {
  const e = {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    value: '',
    textContent: '',
    className: '',
    innerHTML_set: false,
    files: [],
    _html: '',
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
      toggle(c, force) {
        const want = force === undefined ? !this._s.has(c) : Boolean(force);
        if (want) this._s.add(c); else this._s.delete(c);
        return want;
      },
    },
    offsetWidth: 1,
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
    remove() {},
    click() {},
    showModal() {},
    close() {},
    addEventListener() {},
    appendChild() {},
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(e, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); captured.push(String(v)); },
  });
  return e;
}

const singletons = new Map();
function pick(sel) {
  if (!singletons.has(sel)) singletons.set(sel, makeEl());
  return singletons.get(sel);
}

const themeState = {};
globalThis.document = {
  documentElement: { dataset: themeState },
  body: makeEl('body'),
  querySelector: pick,
  querySelectorAll: () => [],
  createElement: (t) => makeEl(t),
  addEventListener() {},
};
globalThis.location = { origin: 'https://ag.example.com', hostname: 'ag.example.com', protocol: 'https:' };
globalThis.localStorage = { getItem: () => null, setItem() {} };
if (!globalThis.navigator) globalThis.navigator = {};
globalThis.matchMedia = () => ({ matches: false });
globalThis.window = { matchMedia: globalThis.matchMedia, localStorage: globalThis.localStorage };
globalThis.confirm = () => false;
globalThis.prompt = () => null;
// 故意不提供 WebSocket：测 REST 降级路径
if (!globalThis.Response) globalThis.Response = class {};

// ---------- 假后端 ----------

const NOW = Date.now();
const STATE = {
  ok: true,
  settings: {
    gatewayBaseUrl: 'https://gw.example.com', hasKey: true, keyMask: 'sk-gw-ab****wxyz',
    model: 'auto', systemPrompt: '', maxToolCalls: 12, maxHistoryChars: 96000,
    readMaxChars: 48000, writeMaxChars: 400000, scheduleEnabled: true,
  },
  defaults: {},
  sessions: [{ id: 's1', title: '测试会话', created_at: NOW, updated_at: NOW }],
};

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/session')) return jsonRes({ authed: true, hasPassword: true });
  if (u.includes('/api/state')) return jsonRes(STATE);
  if (u.match(/\/api\/sessions\/s1\/messages/)) {
    return jsonRes({
      messages: [
        { seq: 1, role: 'user', content: '帮我建个文件', created_at: NOW },
        {
          seq: 2, role: 'assistant', content: '', created_at: NOW,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'workspace_write', arguments: '{"path":"a.md"}' } }],
        },
        { seq: 3, role: 'tool', tool_call_id: 'c1', content: '{"ok":true}', created_at: NOW },
        { seq: 4, role: 'assistant', content: '写好了。', created_at: NOW },
      ],
    });
  }
  if (u.match(/\/api\/sessions\/s1\/tasks/)) return jsonRes({ tasks: [{ id: 't1', instruction: '提醒浇水', due_at: NOW + 60000, created_at: NOW }] });
  if (u.includes('/api/files')) return jsonRes({ ok: true, files: [{ path: 'notes/a.md', size: 1234, mtime: Math.floor(NOW / 1000) }] });
  if (u.includes('/api/file')) return jsonRes({ ok: true, path: 'notes/a.md', content: '# hello', truncated: false });
  if (u.includes('/api/search')) return jsonRes({ ok: true, count: 1, hits: [{ path: 'notes/a.md', snippet: 'hello world' }] });
  return jsonRes({ ok: true });
};
function jsonRes(o) {
  return new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---------- 跑起来 ----------

const src = readFileSync(join(here, '../src/ui/app.js'), 'utf8');
const body = src.replace(/^export function uiApp\(\)\s*\{/m, '(function uiApp(){').replace(/\}\s*$/, '})');
const uiApp = new Function('return (\n' + body + '\n);')();

// 导航按钮必须在 uiApp() 之前就位：render() 绑 onclick 时会查询它们
const navBtns = ['chat', 'files', 'settings'].map((id) => {
  const b = makeEl('button');
  b.dataset.tab = id;
  return b;
});
pick('#root').querySelectorAll = (sel) => {
  if (String(sel).indexOf('.navitem[data-tab]') >= 0) return navBtns;
  return [];
};

console.log('\n[1] 启动');
uiApp();
await new Promise((r) => setTimeout(r, 30));
ok('渲染出了内容', captured.length > 0);
const shellHtml = captured.find((h) => h.includes('class="topbar"'));
ok('外壳（顶栏+导航）渲染出来了', Boolean(shellHtml));
if (shellHtml) {
  ok('有三个导航项', (shellHtml.match(/class="navitem"/g) || []).length === 3);
  ok('顶栏有主题切换和退出', shellHtml.includes('id="themeBtn"') && shellHtml.includes('id="logoutBtn"'));
  const err = checkBalance(shellHtml);
  ok('外壳标签配对正确', !err, err);
}

console.log('\n[2] 逐页渲染 + 标签配对');
const seen = {};
for (const btn of navBtns) {
  captured.length = 0;
  try { btn.onclick && btn.onclick(); } catch (e) { /* 桩环境下个别绑定不可用 */ }
  await new Promise((r) => setTimeout(r, 10));
  // 取第一笔：pane 本体；后续异步刷新（会话列表/文件列表）会有额外的 innerHTML 写入
  seen[btn.dataset.tab] = captured.filter((h) => !h.includes('class="topbar"'))[0] || '';
}

for (const tab of ['chat', 'files', 'settings']) {
  const html = seen[tab] || '';
  if (!html) {
    ok(tab + ' 页渲染出内容', false, '空');
    continue;
  }
  const err = checkBalance(html);
  ok(tab + ' 页标签配对正确', !err, err);
}

console.log('\n[3] 关键内容');
ok('会话页有会话列与输入框', (seen.chat || '').includes('sesscol') && (seen.chat || '').includes('id="input"'));
ok('会话页有工具提示', (seen.chat || '').includes('读写/编辑/删除/检索'));
ok('文件页有上传与检索', (seen.files || '').includes('id="uploadBtn"') && (seen.files || '').includes('id="fileSearch"'));
ok('设置页有网关地址与密钥', (seen.settings || '').includes('gatewayBaseUrl') && (seen.settings || '').includes('gatewayKey'));
ok('设置页有定时任务开关', (seen.settings || '').includes('scheduleEnabled'));
ok('设置页有附加系统提示', (seen.settings || '').includes('systemPrompt'));

console.log('\n' + (fail ? '❌' : '✅') + ' 通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
process.exit(fail ? 1 : 0);
