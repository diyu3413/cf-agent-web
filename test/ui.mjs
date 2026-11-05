// 环境里没有无头浏览器，用一个最小 DOM 桩把前端跑一遍：
// 逐个标签页触发渲染，校验标签配对，并覆盖会话重载、抽屉状态与旧异步回调。
// 桩不做布局：固定定位、动画、遮罩命中仍需真实浏览器验证。
// 手法与 cf-llm-gateway 的 test/ui.mjs 同源。
// 可选：node test/ui.mjs <app.js 路径> embedded，复用同一套回归测试内嵌副本。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const embedded = process.argv[3] === 'embedded';
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
    style: { setProperty(k, v) { this[k] = v; } },
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
    offsetHeight: 100,
    isConnected: true,
    tabIndex: 0,
    hidden: false,
    attrs: {},
    _queries: new Map(),
    _events: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    focus() { document.activeElement = this; },
    remove() {
      this.isConnected = false;
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    },
    closest() { return this.hidden || this.inert ? this : null; },
    matches() { return false; },
    contains(el) { return this === el || this.children.includes(el) || [...this._queries.values()].includes(el); },
    getClientRects() { return this.hidden ? [] : [{}]; },
    reportValidity() { return Boolean(this.value); },
    click() { if (this.onclick) this.onclick(); },
    showModal() { this.open = true; },
    close() { this.open = false; },
    addEventListener(name, fn) { (this._events[name] ||= []).push(fn); },
    removeEventListener(name, fn) { this._events[name] = (this._events[name] || []).filter((f) => f !== fn); },
    dispatch(name, props = {}) {
      const event = { target: this, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...props };
      for (const fn of [...(this._events[name] || [])]) fn(event);
      return event;
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.children = child.parentNode.children.filter((c) => c !== child);
      this.children.push(child); child.parentNode = this; child.isConnected = true; return child;
    },
    querySelector(sel) {
      if (this.tagName !== 'DIALOG' && !this.dataset.id && this !== singletons.get('#snack') && !this.attrs['aria-live']) return pick(sel);
      if (!this._queries.has(sel)) {
        const el = makeEl(sel.includes('input') ? 'input' : 'button');
        const needle = sel.startsWith('#') ? 'id="' + sel.slice(1) + '"' : sel.startsWith('.') ? 'class="' + sel.slice(1) + '"' : sel;
        const markup = this._html.split('<').find((s) => s.includes(needle)) || '';
        el.value = /value="([^"]*)"/.exec(markup)?.[1] || '';
        el.parentNode = this;
        el.disabled = /\bdisabled\b/.test(markup);
        this._queries.set(sel, el);
      }
      return this._queries.get(sel);
    },
    querySelectorAll(sel) {
      if (sel === '.sessitem') return this.children.filter((c) => c.dataset.id);
      if (this.tagName === 'DIALOG' && sel.includes('button,input')) {
        return ['.dialog-close', ...[...this._html.matchAll(/<(?:button|input|textarea|a)\b[^>]*id="([^"]+)"/g)].map((m) => '#' + m[1])].map((s) => this.querySelector(s));
      }
      if (['[data-del]', '[data-open]'].includes(sel)) {
        const attr = sel.slice(1, -1);
        return [...this._html.matchAll(new RegExp('<button[^>]*' + attr + '="([^"]+)"[^>]*>', 'g'))].map((m) => {
          const key = attr + ':' + m[1];
          if (!this._queries.has(key)) {
            const b = makeEl('button'); b.dataset[attr.slice(5)] = m[1]; this._queries.set(key, b);
          }
          return this._queries.get(key);
        });
      }
      return [];
    },
  };
  Object.defineProperty(e, 'innerHTML', {
    get() {
      if (this === singletons.get('#sesslist')) return this.children.map((c) => {
        if (!c.dataset.id) return c.hidden ? '' : c._html;
        return '<div class="sessitem" data-id="' + c.dataset.id + '"' + (c.attrs['aria-current'] ? ' aria-current="true"' : '') + '>' + c._html + [...c._queries.values()].map((q) => q.textContent).join('') + '</div>';
      }).join('');
      return this._html;
    },
    set(v) {
      this._html = String(v);
      this._queries.clear();
      this._sessions = this._status = null;
      for (const child of this.children) child.isConnected = false;
      this.children = [];
      captured.push(String(v));
      if (this === singletons.get('#root')) {
        const old = singletons.get('#sesslist');
        if (old) old.isConnected = false;
        singletons.delete('#sesslist');
      }
      // pane 换页后旧消息容器不再可查询，返回 Chat 时创建新实例。
      if (this === singletons.get('#pane')) {
        for (const id of ['#msglist', '#msgs', '#input', '#sendBtn', '#taskchips', '#sessUsage']) {
          singletons.delete(id);
          if (this._html.includes('id="' + id.slice(1) + '"')) pick(id);
        }
      }
    },
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
const events = {};
const storage = new Map();
const drawerMedia = {
  matches: false,
  addEventListener(name, fn) { this.onchange = fn; },
};
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
if (!globalThis.navigator) globalThis.navigator = {};
const reducedMedia = { matches: false };
let motionMs = 0;
globalThis.matchMedia = (query) => query.includes('840px') ? drawerMedia : query.includes('reduced-motion') ? reducedMedia : { matches: false };
globalThis.window = { matchMedia: globalThis.matchMedia, localStorage: globalThis.localStorage,
  getComputedStyle: () => ({ animationDuration: motionMs + 'ms', animationDelay: '0ms' }) };
document.addEventListener = (name, fn) => { events[name] = fn; };
document.body.dataset.base = embedded ? '/agent' : '';
document.body.dataset.embedded = embedded ? '1' : '';
globalThis.confirm = globalThis.prompt = globalThis.alert = () => { throw new Error('Native popup must not be used'); };
// 故意不提供 WebSocket：测 REST 降级路径
if (!globalThis.Response) globalThis.Response = class {};

// ---------- 假后端 ----------

const NOW = Date.now();
const STATE = {
  ok: true,
  embedded,
  models: [{ id: 'auto', kind: 'chat' }],
  settings: {
    gatewayBaseUrl: 'https://gw.example.com', hasKey: true, keyMask: 'sk-gw-ab****wxyz',
    model: 'auto', systemPrompt: '', maxToolCalls: 12, maxHistoryChars: 96000,
    readMaxChars: 48000, writeMaxChars: 400000, scheduleEnabled: true,
  },
  defaults: {},
  sessions: [{ id: 's1', title: '测试会话', created_at: NOW, updated_at: NOW }],
};

const observers = [];
globalThis.ResizeObserver = class {
  constructor(fn) { this.fn = fn; observers.push(this); }
  observe(el) { this.el = el; }
  disconnect() { this.disconnected = true; }
};

let sessionsFail = false;
let holdSession = null;
let holdState = null;
let stateFail = false;
let holdSessions = null;
let holdCreate = null;
let createFail = false;
let newId = 0;
let sessionsData = null;
let holdHistory = null;
let holdTasks = null;
let holdUsage = null;
let holdMessage = null;
let holdSettings = null;
let holdFile = null;
let fileSaveFail = false;
let truncated = false;
const requests = [];
const writes = [];
globalThis.fetch = async (url, options = {}) => {
  if (options.method) writes.push({ url: String(url), ...options });
  const u = String(url);
  requests.push(u);
  if (u.endsWith('/api/session')) return holdSession ? holdSession.promise : jsonRes({ authed: true, hasPassword: true });
  if (u.endsWith('/api/sessions')) {
    if (options.method === 'POST') {
      if (createFail) return jsonRes({ error: { message: '新建失败测试' } }, 503);
      if (holdCreate) return holdCreate.promise;
      const id = 'new' + (++newId);
      sessionsData = [{ id, title: '', updated_at: NOW }, ...(sessionsData || STATE.sessions)];
      return jsonRes({ ok: true, id });
    }
    if (holdSessions) return holdSessions.promise.then((r) => r.clone());
    if (sessionsFail) return jsonRes({ error: { message: 'D1 暂不可用' } }, 503);
    return jsonRes({ sessions: sessionsData || STATE.sessions });
  }
  if (u.endsWith('/api/settings')) return holdSettings ? holdSettings.promise : jsonRes({ settings: STATE.settings });
  if (u.includes('/api/state')) return holdState ? holdState.promise : stateFail ? jsonRes({ error: { message: '设置失败测试' } }, 503) : jsonRes(STATE);
  if (/\/api\/sessions\/new\d+\/message$/.test(u)) {
    sessionsData = sessionsData.map((s) => s.id === u.split('/').at(-2) ? { ...s, title: '首条消息标题' } : s);
    return jsonRes({ events: [{ type: 'turn_done' }] });
  }
  if (u.endsWith('/api/sessions/s1/message') && holdMessage) return holdMessage.promise;
  if (u.endsWith('/api/sessions/s1/usage')) return holdUsage ? holdUsage.promise : jsonRes({ usage: { prompt: 10, completion: 5 } });
  if (u.match(/\/api\/sessions\/s1\/messages/)) {
    if (holdHistory) return holdHistory.promise;
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
  if (u.match(/\/api\/sessions\/s1\/tasks/)) return holdTasks ? holdTasks.promise : jsonRes({ tasks: [{ id: 't1', instruction: '提醒浇水', due_at: NOW + 60000, created_at: NOW }] });
  if (u.includes('/api/files')) return jsonRes({ ok: true, files: [{ path: 'notes/a.md', size: 1234, mtime: Math.floor(NOW / 1000) }] });
  if (u.includes('/api/file')) {
    if (options.method === 'PUT' && fileSaveFail) return jsonRes({ error: '保存失败测试' }, 500);
    if (holdFile && !options.method) return holdFile.promise;
    return jsonRes({ ok: true, path: 'notes/a.md', content: '# hello', truncated });
  }
  if (u.includes('/api/search')) return jsonRes({ ok: true, count: 1, hits: [{ path: 'notes/a.md', snippet: 'hello world' }] });
  return jsonRes({ ok: true });
};
function jsonRes(o, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const settle = () => new Promise((r) => setTimeout(r, 10));
const messageText = () => pick('#msglist').children.map((e) => e.textContent + e.innerHTML).join('\n');

// ---------- 跑起来 ----------

const src = readFileSync(process.argv[2] || join(here, '../src/ui/app.js'), 'utf8');
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
holdSession = deferred();
holdState = deferred();
holdSessions = deferred();
uiApp();
ok('认证请求未返回时已有可见加载骨架', pick('#root').innerHTML.includes('Agent Workspace') && pick('#root').innerHTML.includes('加载中'));
holdSession.resolve(jsonRes({ authed: true, hasPassword: true }));
holdSession = null;
await settle();
ok('state/列表未返回时外壳与 composer 已渲染', pick('#root').innerHTML.includes('class="topbar"') && pick('#pane').innerHTML.includes('id="input"'));
ok('列表未返回时显示加载中而非空会话', pick('#sesslist').innerHTML.includes('加载中') && !pick('#sesslist').innerHTML.includes('还没有会话'));
navBtns[2].onclick();
ok('state 未返回时设置显示加载状态而非可保存空表单', pick('#pane').innerHTML.includes('加载中') && !pick('#pane').innerHTML.includes('id="saveSet"'));
navBtns[0].onclick();
holdState.resolve(jsonRes(STATE));
holdState = null;
holdSessions.resolve(jsonRes({ sessions: STATE.sessions }));
holdSessions = null;
await new Promise((r) => setTimeout(r, 30));
ok('迟到 state 不覆盖 Chat/选中会话', pick('#pane').innerHTML.includes('id="input"') && pick('#sesslist').innerHTML.includes('data-id="s1" aria-current="true"'));
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
ok('会话列位于 shell 下、main/#pane 之外', shellHtml.includes('</nav><aside class="sesscol"') && shellHtml.indexOf('</aside>') < shellHtml.indexOf('<main>'));
ok('会话页有输入框、不会在 pane 内嵌套抽屉', (seen.chat || '').includes('id="input"') && !(seen.chat || '').includes('sesscol'));
ok('会话页有工具提示', (seen.chat || '').includes('读写/编辑/删除/检索'));
ok('文件页有上传与检索', (seen.files || '').includes('id="uploadBtn"') && (seen.files || '').includes('id="fileSearch"'));
ok('设置页有部署对应的模型设置', embedded
  ? (seen.settings || '').includes('id="f_model"') && !(seen.settings || '').includes('gatewayKey')
  : (seen.settings || '').includes('gatewayBaseUrl') && (seen.settings || '').includes('gatewayKey'));
ok('设置页有定时任务开关', (seen.settings || '').includes('scheduleEnabled'));
ok('设置页有附加系统提示', (seen.settings || '').includes('systemPrompt'));
const css = readFileSync(join(dirname(process.argv[2] || join(here, '../src/ui/app.js')), 'css.js'), 'utf8');
ok('两种抽屉都显示同一遮罩（静态 CSS）', css.includes('body.nav-open .scrim,body.sess-open .scrim{opacity:1;visibility:visible}'));
ok('折叠样式仅限桌面（静态 CSS）', /@media\(min-width:841px\)\{\s*body\.sess-collapsed \.sesscol\{display:none\}/.test(css));
ok('会话列表入口只在 Chat 可见（静态 CSS）', css.includes('.topbar .sessbtn{display:none}') && css.includes('body.view-chat .topbar .sessbtn{display:grid}'));

console.log('\n[4] 设置 → 会话：重载历史与列表');
const beforeHistory = requests.filter((u) => u.endsWith('/messages')).length;
const beforeSessions = requests.filter((u) => u.endsWith('/api/sessions')).length;
sessionsData = [...STATE.sessions, { id: 's2', title: '另一会话', updated_at: NOW }];
navBtns[0].onclick();
await settle();
ok('返回会话重新请求选中 s1 历史', requests.filter((u) => u.endsWith('/messages')).length === beforeHistory + 1);
ok('返回会话刷新列表', requests.filter((u) => u.endsWith('/api/sessions')).length === beforeSessions + 1);
ok('返回后历史消息恢复', messageText().includes('帮我建个文件') && messageText().includes('写好了。'));
ok('返回后列表保持选中并包含新会话', pick('#sesslist').innerHTML.includes('data-id="s1" aria-current="true"') && pick('#sesslist').innerHTML.includes('另一会话'));
ok('返回后任务与用量恢复', pick('#taskchips').innerHTML.includes('提醒浇水') && pick('#sessUsage').innerHTML.includes('tokens'));
navBtns[2].onclick();
await pick('#saveSet').onclick();
navBtns[0].onclick();
await settle();
ok('保存设置后返回仍恢复历史与选中项', messageText().includes('写好了。') && pick('#sesslist').innerHTML.includes('data-id="s1" aria-current="true"'));
holdSettings = deferred();
navBtns[2].onclick();
pick('#saveSet').onclick();
navBtns[0].onclick();
await settle();
holdSettings.resolve(jsonRes({ settings: STATE.settings }));
holdSettings = null;
await settle();
ok('延迟保存响应不覆盖已返回的 Chat DOM', pick('#pane').innerHTML.includes('id="input"') && messageText().includes('写好了。'));

sessionsFail = true;
navBtns[2].onclick();
navBtns[0].onclick();
await settle();
ok('列表失败保留缓存、显示错误和重试', pick('#sesslist').innerHTML.includes('D1 暂不可用') && pick('#sesslist').innerHTML.includes('id="retrySess"') && pick('#sesslist').innerHTML.includes('另一会话'));
sessionsFail = false;
pick('#retrySess').onclick();
await settle();
ok('重试成功清除列表错误', !pick('#sesslist').innerHTML.includes('sesserror'));
// 无缓存的启动失败也不能伪装成「还没有会话」。
navBtns[2].onclick();
STATE.sessions = [];
sessionsFail = true;
uiApp();
await settle();
ok('无缓存时失败不显示空列表文案', pick('#sesslist').innerHTML.includes('id="retrySess"') && !pick('#sesslist').innerHTML.includes('还没有会话'));
sessionsFail = false;
pick('#retrySess').onclick();
await settle();
ok('无缓存重试恢复列表和首个会话', messageText().includes('写好了。'));

console.log('\n[5] 抽屉互斥 / 重置 / 桌面折叠');
pick('#collapseSess').onclick();
ok('桌面折叠列且持久化', document.body.classList.contains('sess-collapsed') && storage.get('agent-sessions-collapsed') === '1' && pick('#sesscol').inert);
ok('顶栏保留可发现的展开入口', pick('#sessBtn').getAttribute('aria-expanded') === 'false' && pick('#sessBtn').title === '展开会话列表');
navBtns[2].onclick();
pick('#sessBtn').onclick();
ok('设置页会话按钮不打开虚空抽屉', pick('#sesscol').hidden && !document.body.classList.contains('sess-open'));
navBtns[0].onclick();
await settle();
ok('切页保留桌面折叠偏好', document.body.classList.contains('sess-collapsed'));
uiApp();
await settle();
ok('重新启动从 localStorage 恢复折叠偏好', document.body.classList.contains('sess-collapsed'));
drawerMedia.matches = true;
drawerMedia.onchange();
pick('#sessBtn').onclick();
ok('移动端可打开会话抽屉、不受桌面折叠影响', document.body.classList.contains('sess-open') && !pick('#sesscol').inert && storage.get('agent-sessions-collapsed') === '1');
pick('#sesslist').querySelectorAll('.sessitem')[0].onclick({ target: {} });
await settle();
ok('选择会话自动关闭移动抽屉', !document.body.classList.contains('sess-open'));
pick('#sessBtn').onclick();
pick('#collapseSess').onclick();
ok('移动抽屉关闭按钮不更改桌面偏好', !document.body.classList.contains('sess-open') && storage.get('agent-sessions-collapsed') === '1');
pick('#sessBtn').onclick();
pick('#menuBtn').onclick();
ok('打开导航关闭会话抽屉', document.body.classList.contains('nav-open') && !document.body.classList.contains('sess-open'));
pick('#sessBtn').onclick();
ok('打开会话关闭导航抽屉', document.body.classList.contains('sess-open') && !document.body.classList.contains('nav-open'));
pick('#scrim').onclick();
ok('遮罩关闭两种抽屉', !document.body.classList.contains('nav-open') && !document.body.classList.contains('sess-open'));
pick('#sessBtn').onclick();
events.keydown({ key: 'Escape' });
ok('Escape 关闭抽屉', !document.body.classList.contains('sess-open'));
pick('#sessBtn').onclick();
navBtns[1].onclick();
ok('切标签重置抽屉并隐藏会话列', !document.body.classList.contains('sess-open') && !document.body.classList.contains('nav-open') && pick('#sesscol').hidden);
navBtns[0].onclick();
await settle();
pick('#sessBtn').onclick();
drawerMedia.matches = false;
drawerMedia.onchange();
ok('跨断点关闭抽屉、保留桌面折叠', !document.body.classList.contains('sess-open') && document.body.classList.contains('sess-collapsed'));
pick('#sessBtn').onclick();
ok('桌面顶栏重新展开并持久化', !document.body.classList.contains('sess-collapsed') && storage.get('agent-sessions-collapsed') === '0');

console.log('\n[6] 延迟响应 / 已断开 WS 不写旧 DOM');
holdHistory = deferred();
navBtns[0].onclick();
const selectedS2 = pick('#sesslist').querySelectorAll('.sessitem')[1];
selectedS2.onclick({ target: {} });
await settle();
holdHistory.resolve(jsonRes({ messages: [{ role: 'user', content: '过期 s1 历史' }] }));
holdHistory = null;
await settle();
ok('快速切会话忽略旧历史、保持 s2 选中', !messageText().includes('过期 s1 历史') && pick('#sesslist').innerHTML.includes('data-id="s2" aria-current="true"'));
pick('#sesslist').querySelectorAll('.sessitem')[0].onclick({ target: {} });
await settle();
holdHistory = deferred();
navBtns[2].onclick();
navBtns[0].onclick();
navBtns[2].onclick();
holdHistory.resolve(jsonRes({ messages: [{ role: 'user', content: '过期历史' }] }));
holdHistory = null;
await settle();
ok('离开会话后延迟历史不重建消息 DOM', !singletons.has('#msglist'));
navBtns[0].onclick();
await settle();
holdTasks = deferred();
holdUsage = deferred();
navBtns[0].onclick();
await settle();
const oldTasks = holdTasks, oldUsage = holdUsage;
holdTasks = holdUsage = null;
navBtns[2].onclick();
navBtns[0].onclick();
await settle();
oldTasks.resolve(jsonRes({ tasks: [{ instruction: '过期任务' }] }));
oldUsage.resolve(jsonRes({ usage: { prompt: 99999, completion: 99999 } }));
await settle();
ok('旧任务/用量响应不会污染新会话视图', !pick('#taskchips').innerHTML.includes('过期任务') && !pick('#sessUsage').innerHTML.includes('100.0k'));
holdMessage = deferred();
pick('#input').value = 'REST 请求';
pick('#sendBtn').onclick();
navBtns[2].onclick();
navBtns[0].onclick();
await settle();
holdMessage.resolve(jsonRes({ events: [{ type: 'delta', text: '过期 REST 增量' }] }));
holdMessage = null;
await settle();
ok('旧 REST 响应不回放到新消息视图', !messageText().includes('过期 REST 增量'));

const sockets = [];
globalThis.WebSocket = class {
  constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); }
  send() {}
  close() { this.readyState = 3; this.closed = true; }
};
navBtns[0].onclick();
await settle();
const oldWs = sockets.at(-1);
oldWs.onopen();
oldWs.onmessage({ data: JSON.stringify({ type: 'delta', text: '原视图流' }) });
const oldList = pick('#msglist');
const oldStream = oldList.children.at(-1).children[0];
const queuedDelta = oldWs.onmessage;
const queuedOpen = oldWs.onopen;
navBtns[2].onclick();
queuedDelta({ data: JSON.stringify({ type: 'delta', text: '不该追加' }) });
queuedOpen();
ok('离开会话关闭 WS 并解绑回调', oldWs.closed && oldWs.onmessage === null && oldWs.onopen === null);
ok('已排队旧 WS 回调不写脱离 DOM', oldStream.textContent === '原视图流' && !singletons.has('#msglist'));
navBtns[0].onclick();
await settle();
const newWs = sockets.at(-1);
newWs.onmessage({ data: JSON.stringify({ type: 'hello', busy: true }) });
ok('返回重连读取服务端 busy 状态', pick('#input').placeholder.includes('正在干活'));
newWs.onmessage({ data: JSON.stringify({ type: 'delta', text: '新视图流' }) });
ok('新 WS 流绑定新消息 DOM', pick('#msglist') !== oldList && pick('#msglist').children.at(-1).children[0].textContent === '新视图流');
newWs.onmessage({ data: JSON.stringify({ type: 'turn_done' }) });
await settle();
ok('重连中的回合完成后补全落盘历史', messageText().includes('写好了。') && newWs.closed && sockets.at(-1) !== newWs);
ok('API / WS 保留部署路径前缀', requests.every((u) => u.startsWith((embedded ? '/agent' : '') + '/api/')) && sockets.every((ws) => ws.url.includes((embedded ? '/agent' : '') + '/ws?session=')));
navBtns[2].onclick(); // 关闭 ping 定时器

console.log('\n[7] MD3 对话框 / 键盘 / 动效');
const currentDialog = () => document.body.children.find((el) => el.tagName === 'DIALOG' && el.open);
const delSession = () => pick('#sesslist').querySelectorAll('.sessitem')[0].querySelector('[data-del]');
navBtns[0].onclick();
await settle();
const opener = delSession();
opener.focus();
const beforeDelete = writes.filter((w) => w.method === 'DELETE').length;
let confirmation = opener.onclick({ stopPropagation() {} });
let dlg = currentDialog();
ok('删除会话使用有标题/描述的 modal 与关闭按钮', dlg && dlg.attrs['aria-labelledby'] && dlg.attrs['aria-describedby'] === 'dialog-description' && dlg.attrs['aria-modal'] === 'true' && dlg.innerHTML.includes('dialog-close'));
ok('删除初始焦点位于安全的取消按钮', document.activeElement === dlg.querySelector('#dialog-cancel'));
ok('modal 打开期间锁定页面滚动', document.body.classList.contains('dialog-open'));
const focusables = dlg.querySelectorAll('button,input,select,textarea,a[href],[tabindex]');
focusables.at(-1).focus();
const forward = dlg.dispatch('keydown', { key: 'Tab' });
ok('Tab 从末尾循环到第一个按钮', forward.prevented && document.activeElement === focusables[0]);
const backward = dlg.dispatch('keydown', { key: 'Tab', shiftKey: true });
ok('Shift+Tab 从首项循环到末尾', backward.prevented && document.activeElement === focusables.at(-1));
dlg.dispatch('keydown', { key: 'Escape' });
await confirmation;
ok('Escape 关闭、归还焦点、取消不发送 DELETE', !currentDialog() && !document.body.classList.contains('dialog-open') && document.activeElement === opener && writes.filter((w) => w.method === 'DELETE').length === beforeDelete);
confirmation = opener.onclick({ stopPropagation() {} });
dlg = currentDialog();
const cancel = dlg.dispatch('cancel');
await confirmation;
ok('原生 cancel 事件走统一清理', cancel.prevented && !dlg.isConnected && !currentDialog());
confirmation = opener.onclick({ stopPropagation() {} });
currentDialog().querySelector('.dialog-close').onclick();
await confirmation;
ok('显式 X 关闭按钮取消确认', !currentDialog());
confirmation = opener.onclick({ stopPropagation() {} });
currentDialog().querySelector('#dialog-accept').onclick();
await confirmation;
ok('确认删除只发送一次、使用正确会话路径', writes.filter((w) => w.method === 'DELETE').length === beforeDelete + 1 && writes.filter((w) => w.method === 'DELETE').at(-1).url.endsWith('/api/sessions/s1'));
confirmation = delSession().onclick({ stopPropagation() {} });
dlg = currentDialog();
navBtns[1].onclick();
await confirmation;
await settle();
ok('切页立即关闭对话框、不执行过期删除', !dlg.isConnected && !currentDialog() && writes.filter((w) => w.method === 'DELETE').length === beforeDelete + 1);

const fileOpen = pick('#filelist').querySelectorAll('[data-open]')[0];
await fileOpen.onclick();
dlg = currentDialog();
ok('文件预览复用 modal，内容安全使用 textContent', dlg && dlg.querySelector('#pvView').textContent === '# hello' && !checkBalance(dlg.innerHTML));
dlg.querySelector('#pvToggle').onclick();
ok('编辑模式移动焦点到带标签的 textarea', document.activeElement === dlg.querySelector('#pvEdit') && dlg.innerHTML.includes('label for="pvEdit"'));
fileSaveFail = true;
await dlg.querySelector('#pvToggle').onclick();
ok('保存失败保留编辑状态，错误可在 top layer 内阅读', !dlg.querySelector('#pvEditField').hidden && !dlg.querySelector('.dialog-status').hidden);
fileSaveFail = false;
await dlg.querySelector('#pvToggle').onclick();
ok('保存成功切到预览并在 modal 内提示', dlg.querySelector('#pvEditField').hidden && !dlg.querySelector('#pvView').hidden && !dlg.querySelector('.dialog-status').hidden);
dlg.querySelector('#pvClose').onclick();
ok('预览关闭恢复仍连接的打开按钮焦点', !currentDialog() && document.activeElement === fileOpen);
truncated = true;
await pick('#filelist').querySelectorAll('[data-open]')[0].onclick();
dlg = currentDialog();
ok('截断预览禁用编辑，避免保存不完整内容', dlg.querySelector('#pvToggle').disabled);
dlg.querySelector('.dialog-close').onclick();
truncated = false;
holdFile = deferred();
const pendingPreview = pick('#filelist').querySelectorAll('[data-open]')[0].onclick();
navBtns[2].onclick();
holdFile.resolve(jsonRes({ content: '过期预览' }));
holdFile = null;
await pendingPreview;
ok('离开文件页后延迟响应不会打开幽灵 modal', !currentDialog());
navBtns[1].onclick();
await settle();
holdFile = deferred();
const stalePreview = pick('#filelist').querySelectorAll('[data-open]')[0].onclick();
const previewResponse = holdFile;
holdFile = null;
await pick('#filelist').querySelectorAll('[data-open]')[0].onclick();
const latestDialog = currentDialog();
previewResponse.resolve(jsonRes({ content: '旧文件预览' }));
await stalePreview;
ok('乱序预览响应不会替换最新 modal', currentDialog() === latestDialog && latestDialog.querySelector('#pvView').textContent === '# hello');
latestDialog.querySelector('.dialog-close').onclick();
const inputFile = pick('#fileInput');
inputFile.files = [{ name: 'upload.md', size: 10, text: async () => 'hello' }];
const pendingUpload = inputFile.onchange();
dlg = currentDialog();
ok('上传路径 prompt 已换成带标签的 modal 输入', dlg && document.activeElement === dlg.querySelector('#dialog-input') && dlg.querySelector('#dialog-input').value === 'upload.md');
dlg.querySelector('#dialog-input').value = '';
dlg.querySelector('#dialog-accept').onclick();
ok('空路径不关闭 modal', currentDialog() === dlg);
dlg.querySelector('#dialog-input').value = 'notes/upload.md';
dlg.querySelector('#dialog-input').onkeydown({ key: 'Enter', preventDefault() {} });
await pendingUpload;
ok('Enter 确认上传路径并请求上传接口', writes.some((w) => w.url.endsWith('/api/upload?path=notes%2Fupload.md')));
const snack = pick('#snack');
ok('toast 是非模态 status snackbar，带键盘可达关闭按钮', snack.attrs.role === 'status' && snack.attrs['aria-live'] === 'polite' && snack.innerHTML.includes('snack-close'));
snack.querySelector('.snack-close').onclick();
ok('关闭提示不会留下可聚焦隐藏按钮', snack.hidden);
const fileDel = pick('#filelist').querySelectorAll('[data-del]')[0];
const pendingFileDelete = fileDel.onclick();
dlg = currentDialog();
ok('文件删除也使用同一明确的确认 modal', dlg && dlg.innerHTML.includes('notes/a.md'));
dlg.querySelector('#dialog-cancel').onclick();
await pendingFileDelete;

motionMs = 250;
navBtns[2].onclick();
ok('切 tab 重启动画钩子', pick('#pane').classList.contains('enter'));
pick('#pane').dispatch('animationend');
ok('页动画结束释放 enter 类', !pick('#pane').classList.contains('enter'));
navBtns[0].onclick();
await settle();
const kept = pick('#sesslist').querySelectorAll('.sessitem')[0];
pick('#refreshSess').onclick();
await settle();
ok('刷新列表复用节点、不重复入场', pick('#sesslist').querySelectorAll('.sessitem')[0] === kept);
sessionsData = [...sessionsData, { id: 's3', title: '动效会话', updated_at: NOW }];
pick('#refreshSess').onclick();
await settle();
const entering = pick('#sesslist').querySelectorAll('.sessitem').find((el) => el.dataset.id === 's3');
ok('仅新增会话挂 enter 动画', entering.classList.contains('enter'));
entering.dispatch('animationend');
sessionsData = sessionsData.filter((s) => s.id !== 's3');
pick('#refreshSess').onclick();
await settle();
ok('移除会话先退出并 inert，再结束后移除', entering.classList.contains('leaving') && entering.inert && entering.isConnected);
entering.dispatch('animationend');
ok('退出结束确实清理节点', !entering.isConnected);
const leavingAgain = { id: 's4', title: '回归会话', updated_at: NOW };
sessionsData = [...sessionsData, leavingAgain];
pick('#refreshSess').onclick();
await settle();
const returning = pick('#sesslist').querySelectorAll('.sessitem').find((el) => el.dataset.id === 's4');
sessionsData = sessionsData.filter((s) => s.id !== 's4');
pick('#refreshSess').onclick();
await settle();
sessionsData = [...sessionsData, leavingAgain];
pick('#refreshSess').onclick();
await settle();
returning.dispatch('animationend');
ok('退出途中重新出现的 id 取消删除/解除 inert', returning.isConnected && !returning.inert && !returning.classList.contains('leaving'));
const selectFocus = kept.querySelector('.sess-select');
selectFocus.focus();
sessionsData = [...sessionsData].reverse();
pick('#refreshSess').onclick();
await settle();
ok('排序变化仍保留列表选择按钮焦点', document.activeElement === selectFocus && pick('#sesslist').querySelectorAll('.sessitem')[0].dataset.id === sessionsData[0].id);
confirmation = delSession().onclick({ stopPropagation() {} });
dlg = currentDialog();
dlg.querySelector('#dialog-cancel').onclick();
ok('modal 退出期间保持 top layer 和 scrim', dlg.open && dlg.classList.contains('leaving'));
dlg.dispatch('animationcancel');
dlg.dispatch('animationend', { pseudoElement: '::backdrop' });
ok('入场取消/backdrop 结束不会提前清理 modal', dlg.open && dlg.isConnected);
dlg.dispatch('animationend');
await confirmation;
ok('modal 退出结束清理并归还焦点', !dlg.open && !dlg.isConnected);
reducedMedia.matches = true;
navBtns[2].onclick();
ok('reduced-motion 不重启页入场', !pick('#pane').classList.contains('enter'));
navBtns[0].onclick();
await settle();
confirmation = delSession().onclick({ stopPropagation() {} });
dlg = currentDialog();
dlg.querySelector('#dialog-cancel').onclick();
await confirmation;
ok('reduced-motion 关闭不等待动画', !dlg.open);
const liveWs = sockets.at(-1);
liveWs.onmessage({ data: JSON.stringify({ type: 'delta', text: '动效流' }) });
const live = pick('#msglist').children.at(-1);
ok('流式消息只在首次创建时有 entering 钩子', live.className.includes('entering'));
liveWs.onmessage({ data: JSON.stringify({ type: 'delta', text: '追加' }) });
ok('后续流式增量复用原节点、不重新插入', pick('#msglist').children.at(-1) === live);
ok('历史重载不让每条消息重复入场', !pick('#msglist').children.filter((e) => e.textContent === '帮我建个文件').some((e) => e.className.includes('entering')));
ok('pane 使用无 transform 的 fadeIn（静态 CSS）', css.includes('#pane.enter{animation:fadeIn var(--dur-m) var(--ease-emph-out)}'));
ok('dialog scrim / exit 使用现有时长令牌（静态 CSS）', css.includes('dialog::backdrop{background:var(--md-sys-color-scrim)') && css.includes('dialog.leaving{animation:dlgOut var(--dur-s)'));
ok('reduced-motion 去除延迟及滚动动画（静态 CSS）', css.includes('animation-delay:0ms!important') && css.includes('scroll-behavior:auto!important'));
ok('没有原生 alert/confirm/prompt 调用（静态源码）', !/\b(?:alert|confirm|prompt)\s*\(/.test(src));
navBtns[2].onclick();

console.log('\n[8] 新建立即可见 / 首条消息去重 / 非阻塞加载');
motionMs = 0;
reducedMedia.matches = false;
delete globalThis.WebSocket;
navBtns[0].onclick();
await settle();
const savedSessions = [...sessionsData];
const savedSelection = pick('#sesslist').querySelectorAll('.sessitem').find((el) => el.attrs['aria-current'] === 'true').dataset.id;
holdSessions = deferred();
const staleSessions = holdSessions;
pick('#refreshSess').onclick();
const beforeCreate = writes.filter((w) => w.url.endsWith('/api/sessions') && w.method === 'POST').length;
const creation = pick('#newSess').onclick();
pick('#newSess').onclick();
await creation;
await settle();
const newRow = pick('#sesslist').querySelectorAll('.sessitem')[0];
ok('新建不等待列表 GET，立即在顶部且选中', newRow.dataset.id === 'new1' && newRow.attrs['aria-current'] === 'true' && pick('#sesslist').scrollTop === 0);
ok('重复点击待定新建仅发一次 POST', writes.filter((w) => w.url.endsWith('/api/sessions') && w.method === 'POST').length === beforeCreate + 1);
staleSessions.resolve(jsonRes({ sessions: savedSessions }));
holdSessions = null;
await settle();
ok('早于创建的旧列表响应不移除/取消选中新行', pick('#sesslist').querySelectorAll('.sessitem')[0] === newRow && newRow.attrs['aria-current'] === 'true');
navBtns[2].onclick();
navBtns[0].onclick();
await settle();
ok('发送前空会话从设置返回仍选中且只有一个条目', pick('#sesslist').querySelectorAll('.sessitem').filter((el) => el.dataset.id === 'new1').length === 1 && newRow.attrs['aria-current'] === 'true');
pick('#input').value = '首条消息';
await pick('#sendBtn').onclick();
await settle();
ok('发送首条消息沿用已创建 id，不重复 POST 创建', writes.some((w) => w.url.endsWith('/api/sessions/new1/message')) && writes.filter((w) => w.url.endsWith('/api/sessions') && w.method === 'POST').length === beforeCreate + 1);
ok('发送后列表仅一个同 id 行并原地更新标题/选中', pick('#sesslist').querySelectorAll('.sessitem').filter((el) => el.dataset.id === 'new1').length === 1 && newRow.querySelector('.t').textContent === '首条消息标题' && newRow.attrs['aria-current'] === 'true');
navBtns[2].onclick();
navBtns[0].onclick();
await settle();
ok('发送后的新会话设置返回仍恢复其选中态', pick('#sesslist').querySelectorAll('.sessitem')[0].attrs['aria-current'] === 'true');
const activeObserver = observers.at(-1);
activeObserver.el.offsetHeight = 260;
activeObserver.fn();
ok('composer 高度变化更新 snackbar 避让高度', document.body.style['--composer-height'] === '260px');
ok('snackbar 避让含入场位移且保留 MD3 动效（静态 CSS）', css.includes('body.view-chat #snack{bottom:calc(var(--composer-height,280px) + 24px)}') && css.includes('transform:translate(-50%,16px)') && css.includes('transform var(--dur-m) var(--ease-emph-out)'));
navBtns[2].onclick();
ok('离开 Chat 释放 composer 观察器', activeObserver.disconnected);
navBtns[0].onclick();
await settle();
createFail = true;
const rowsBeforeFailure = pick('#sesslist').querySelectorAll('.sessitem').length;
await pick('#newSess').onclick();
ok('创建失败无幽灵行，解除按钮禁用并保留错误', pick('#sesslist').querySelectorAll('.sessitem').length === rowsBeforeFailure && !pick('#newSess').disabled && snack.querySelector('.snack-text').textContent === '新建失败测试');
createFail = false;
holdCreate = deferred();
const pendingCreation = pick('#newSess').onclick();
navBtns[2].onclick();
holdCreate.resolve(jsonRes({ id: 'new2' }));
holdCreate = null;
await pendingCreation;
navBtns[0].onclick();
await settle();
ok('离开 Chat 后迟到新建不抢占返回的选中会话', pick('#sesslist').querySelectorAll('.sessitem').find((el) => el.dataset.id === 'new1').attrs['aria-current'] === 'true');
// 启动失败必须可重试；state 失败不能让用户保存空设置。
holdSession = deferred();
uiApp();
holdSession.resolve(jsonRes({ error: { message: '认证网络失败测试' } }, 503));
holdSession = null;
await settle();
ok('认证加载失败保留重试而非伪装未登录', pick('#root').innerHTML.includes('id="retryBoot"') && pick('#root').innerHTML.includes('认证网络失败测试'));
stateFail = true;
await pick('#retryBoot').onclick();
await settle();
navBtns[2].onclick();
ok('state 加载失败显示错误与重试，不可保存空值', pick('#pane').innerHTML.includes('id="retryState"') && pick('#pane').innerHTML.includes('设置失败测试') && !pick('#pane').innerHTML.includes('id="saveSet"'));
stateFail = false;
await pick('#retryState').onclick();
ok('state 重试成功填充可保存设置', pick('#pane').innerHTML.includes('id="saveSet"'));
sessionsData = savedSessions;
navBtns[0].onclick();
await settle();
pick('#sesslist').querySelectorAll('.sessitem').find((el) => el.dataset.id === savedSelection).onclick({ target: {} });
await settle();
navBtns[2].onclick();

console.log('\n' + (fail ? '❌' : '✅') + ' 通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
process.exit(fail ? 1 : 0);
