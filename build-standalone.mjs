/*
 * 生成 standalone.html：把 CSS、Three.js、游戏逻辑全部内联进一个 HTML 文件。
 * 产物可以直接双击用浏览器打开（file:// 也能跑），完全离线、零依赖。
 * 改动 game.js / style.css 后执行：node build-standalone.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');

const html = read('index.html');
const css = read('style.css');
const three = read('vendor/three.module.js');
const game = read('game.js').replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+['"][^'"]+['"]\s*;?\s*$/m, '');

if (game.includes('import ')) {
  throw new Error('game.js 仍包含 import 语句，无法内联');
}

// 从 three.module.js 末尾的 export 列表构造 THREE 命名空间对象
const match = three.match(/export\s*\{([\s\S]*?)\}\s*;?\s*$/);
if (!match) throw new Error('未找到 three.module.js 的 export 列表');

const entries = match[1]
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => {
    const parts = s.split(/\s+as\s+/);
    if (parts.length === 2) return `${parts[1]}: ${parts[0]}`;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s)) {
      throw new Error('无法处理的导出名: ' + s);
    }
    return s;
  });

if (/<\/script/i.test(three + game + css)) {
  throw new Error('内联内容包含 </script>，会截断 HTML');
}

const bundle = [
  three,
  `const THREE = { ${entries.join(', ')} };`,
  '{', // 块作用域隔离，避免与 Three.js 内部顶层声明重名
  game,
  '}',
].join('\n');

// 必须用函数式替换：Three.js 源码里存在 '$' 等字符，直接传字符串会被
// String.replace 当成 $& / $' 等特殊替换符而破坏代码。
const out = html
  .replace(/<link rel="stylesheet" href="\.\/style\.css"\s*\/?>/, () => `<style>\n${css}\n</style>`)
  .replace(/<script type="module" src="\.\/game\.js"><\/script>/, () => `<script type="module">\n${bundle}\n</script>`);

if (out.includes('href="./style.css"') || out.includes('src="./game.js"')) {
  throw new Error('HTML 替换失败，请检查 index.html 的引用写法');
}

fs.writeFileSync(path.join(dir, 'standalone.html'), out);
console.log(`standalone.html 已生成：${(Buffer.byteLength(out) / 1024 / 1024).toFixed(2)} MB，导出 ${entries.length} 个 THREE 成员`);
