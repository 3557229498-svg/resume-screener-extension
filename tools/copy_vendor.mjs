/* tools/copy_vendor.mjs
 * 把 npm 里的 pdfjs-dist / tesseract.js 拷贝到 vendor/ 目录。
 * MV3 禁止加载远程脚本，所以这两个库必须打进插件包里。
 * 用法：node tools/copy_vendor.mjs
 */
import { copyFile, cp, mkdir, readdir, access } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();

/** 拷贝文件，源不存在时给出明确提示而不是直接崩 */
async function tryCopy(from, to) {
  const src = path.join(root, from);
  try {
    await access(src);
  } catch {
    console.warn(`[跳过] 找不到 ${from}`);
    return false;
  }
  await mkdir(path.dirname(path.join(root, to)), { recursive: true });
  await copyFile(src, path.join(root, to));
  console.log(`[拷贝] ${from}  ->  ${to}`);
  return true;
}

async function tryCpDir(from, to) {
  const src = path.join(root, from);
  try {
    await access(src);
  } catch {
    console.warn(`[跳过] 找不到目录 ${from}`);
    return;
  }
  await cp(src, path.join(root, to), { recursive: true });
  console.log(`[拷贝] ${from}/  ->  ${to}/`);
}

async function main() {
  // ---------- pdf.js ----------
  await tryCopy('node_modules/pdfjs-dist/build/pdf.mjs',        'vendor/pdfjs/pdf.mjs');
  await tryCopy('node_modules/pdfjs-dist/build/pdf.worker.mjs', 'vendor/pdfjs/pdf.worker.mjs');
  // 中文 CID 字体必需的 cmaps，以及标准字体数据
  await tryCpDir('node_modules/pdfjs-dist/cmaps',          'vendor/pdfjs/cmaps');
  await tryCpDir('node_modules/pdfjs-dist/standard_fonts', 'vendor/pdfjs/standard_fonts');

  // ---------- tesseract.js ----------
  // ESM 主库（供 app.js 以模块方式 import）
  if (!await tryCopy('node_modules/tesseract.js/dist/tesseract.esm.min.js',
                     'vendor/tesseract/tesseract.esm.min.js')) {
    await tryCopy('node_modules/tesseract.js/dist/tesseract.min.js',
                  'vendor/tesseract/tesseract.min.js');
  }
  // worker（在 Web Worker 里跑的那个脚本）
  await tryCopy('node_modules/tesseract.js/dist/worker.min.js',
                'vendor/tesseract/worker.min.js');
  // wasm 核心：整包拷过去，程序启动时会自动探测可用的那个
  const coreDir = path.join(root, 'node_modules/tesseract.js-core');
  try {
    const files = await readdir(coreDir);
    for (const f of files) {
      if (f.startsWith('tesseract-core')) {
        await tryCopy(`node_modules/tesseract.js-core/${f}`, `vendor/tesseract/${f}`);
      }
    }
  } catch {
    console.warn('[跳过] 找不到 node_modules/tesseract.js-core');
  }

  console.log('\n依赖拷贝完成。');
}

main().catch((e) => { console.error(e); process.exit(1); });
