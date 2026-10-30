// markdown 渲染器与联网工具的单测。
// 运行：node test/md-web.mjs

import { renderMarkdown } from '../src/ui/md.js';
import { execWebTool, webToolsSchema, webSearchEnabled, webFetchEnabled } from '../src/lib/webtools.js';

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

console.log('\n[1] markdown 渲染：语法');
ok('粗体', renderMarkdown('**b**').includes('<strong>b</strong>'));
ok('斜体', renderMarkdown('*i*').includes('<em>i</em>'));
ok('删除线', renderMarkdown('~~s~~').includes('<del>s</del>'));
ok('行内代码', renderMarkdown('`c`').includes('<code class="mdcode-i">c</code>'));
ok('标题层级', renderMarkdown('### t').includes('<h3>t</h3>'));
ok('无序列表', renderMarkdown('- a\n- b').includes('<ul>') && renderMarkdown('- a').includes('<li>a</li>'));
ok('有序列表（含中文顿号）', renderMarkdown('1. x\n2、y').includes('<ol>') && renderMarkdown('2、y').includes('<li>y</li>'));
ok('引用', renderMarkdown('> q').includes('<blockquote>') && renderMarkdown('> q').includes('<p>q</p>'));
ok('分割线', renderMarkdown('---').includes('<hr>'));
ok('链接新窗口', renderMarkdown('[t](https://x.test/a)').includes('target="_blank"') && renderMarkdown('[t](https://x.test/a)').includes('rel="noopener noreferrer"'));
ok('小数不误判为列表', !renderMarkdown('3.14 是圆周率').includes('<ol>'));
ok('围栏代码块转义', renderMarkdown('```js\nvar a="<b>";\n```').includes('var a=&quot;&lt;b&gt;&quot;'));
ok('语言标签', renderMarkdown('```json\n{}\n```').includes('mdlang'));
ok('非 http 链接不渲染', !renderMarkdown('[t](javascript:alert(1))').includes('<a '));
ok('未闭合围栏也收得住', renderMarkdown('```\ncode').includes('code'));

console.log('\n[2] markdown 渲染：安全（转义优先）');
ok('script 标签被转义', !renderMarkdown('<script>alert(1)</script>').includes('<script>'));
ok('img onerror 被转义', !renderMarkdown('<img src=x onerror=alert(1)>').includes('<img'));
ok('链接文本里的 HTML 被转义', !renderMarkdown('[<b>x</b>](https://a.test)').includes('<b>'));

console.log('\n[3] 联网工具');
ok('未配置搜索 → schema 只有 fetch', webToolsSchema({ webSearchUrl: '', webFetchEnabled: true }).length === 1);
ok('全关 → schema 为空', webToolsSchema({ webSearchUrl: '', webFetchEnabled: false }).length === 0);
ok('全开 → 两个工具', webToolsSchema({ webSearchUrl: 'https://s.test/search' }).length === 2);
ok('enabled 探测', webSearchEnabled({ webSearchUrl: 'x' }) && !webSearchEnabled({}) && webFetchEnabled({}) && !webFetchEnabled({ webFetchEnabled: false }));

{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/search')) {
      return new Response(
        JSON.stringify({ answer: '直接回答', results: [{ title: 'T', url: 'https://a.test', content: '内容摘要' }] }),
        { status: 200 }
      );
    }
    return new Response('nope', { status: 404 });
  };
  try {
    const r = await execWebTool('web_search', { query: '测试' }, { webSearchUrl: 'https://s.test/search', webSearchKey: 'tvly-x' });
    ok('web_search 解析 Tavily 形状', r.ok && r.count === 2 && r.results[1].title === 'T', JSON.stringify(r));
    ok('直接回答置顶带上', r.results[0].title.includes('直接回答') && r.results[0].snippet.includes('直接回答'));
    const r2 = await execWebTool('web_search', { query: 'x' }, { webSearchUrl: '' });
    ok('未配置时给出可读错误', !r2.ok && r2.error.includes('未配置'));
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      '<html><head><style>x{}</style></head><body><h1>标题</h1><p>正文段落</p><script>bad()</script></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } }
    );
  try {
    const r = await execWebTool('web_fetch', { url: 'https://p.test/page' }, {});
    ok('web_fetch 剥 HTML 成文本', r.ok && r.content.includes('正文段落') && r.content.includes('标题'), JSON.stringify(r).slice(0, 160));
    ok('script/style 内容被剥掉', !r.content.includes('bad()') && !r.content.includes('x{}'));
    const r2 = await execWebTool('web_fetch', { url: 'ftp://x' }, {});
    ok('非 http 被拒', !r2.ok);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('\n✅ markdown/联网单测通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
