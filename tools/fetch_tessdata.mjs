/* tools/fetch_tessdata.mjs
 * 自动下载 OCR 语言包到 tessdata/ 目录（约 25MB）。
 * 用法：node tools/fetch_tessdata.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';

const LANGS = ['chi_sim', 'eng'];                       // 简体中文 + 英文
const BASE  = 'https://tessdata.projectnaptha.com/4.0.0';

await mkdir('tessdata', { recursive: true });

for (const lang of LANGS) {
  const url = `${BASE}/${lang}.traineddata.gz`;
  process.stdout.write(`下载 ${lang} ... `);
  try {
    const res = await fetch(url);                        // Node 18+ 自带 fetch
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(`tessdata/${lang}.traineddata.gz`, buf);
    console.log(`${(buf.length / 1048576).toFixed(1)} MB`);
  } catch (e) {
    console.log('失败：' + e.message);
  }
}
console.log('\n语言包下载完成，目录：tessdata/');
