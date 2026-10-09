const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const root = join(__dirname, '..')
const data = JSON.parse(readFileSync(join(root, 'src/shared/release-history.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (data.version !== pkg.version) throw new Error('版本日志与 package.json 版本不一致')
const encodeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
const status = data.released ? '已发布' : data.title + ' · 尚未发布'
const markdown =
  `# Vork Shell 版本日志\n\nv${data.version} · ${status}\n\n` +
  data.entries
    .map((e) => `## ${e.date} · ${e.title}\n\n` + e.changes.map((c) => '- ' + c).join('\n'))
    .join('\n\n') +
  '\n'
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vork Shell · 版本日志</title><style>:root{color-scheme:light dark;--bg:#f7f7f4;--fg:#25282b;--muted:#666e76;--line:#deded9;--accent:#b36b17}@media(prefers-color-scheme:dark){:root{--bg:#191c1f;--fg:#e3e5e8;--muted:#a4abb3;--line:#373c42;--accent:#e0aa61}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.8 system-ui,sans-serif}main{max-width:860px;margin:auto;padding:64px 24px}header{padding-bottom:28px;border-bottom:1px solid var(--line)}h1{font-size:36px;letter-spacing:-1px;margin:8px 0}header p{color:var(--muted)}article{border-left:2px solid var(--line);padding:0 0 0 24px;margin-top:40px}time{font:14px monospace;color:var(--accent)}h2{font-size:22px;margin:8px 0 16px}li{color:var(--muted);margin:10px 0}ul{padding-left:20px}.logo{color:var(--accent);font-weight:700}</style><main><header><div class="logo">vork / shell</div><h1>版本日志</h1><p>v${encodeHtml(data.version)} · ${encodeHtml(status)}</p><p>按实际开发日期，查看万能终端的功能迭代。</p></header>${data.entries.map((e) => `<article><time datetime="${encodeHtml(e.date)}">${encodeHtml(e.date)}</time><h2>${encodeHtml(e.title)}</h2><ul>${e.changes.map((c) => `<li>${encodeHtml(c)}</li>`).join('')}</ul></article>`).join('')}</main></html>\n`
const outputs = [
  ['CHANGELOG.md', markdown],
  ['public/changelog.html', html],
]
for (const [file, text] of outputs) {
  const path = join(root, file)
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== text) throw new Error(file + '需重新生成')
  } else {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
}
console.log('Version notes ' + (process.argv.includes('--check') ? 'verified' : 'generated'))
