/* =========================================================================
 * app.js —— 简历筛选助手主逻辑
 *   1) 读取白名单 / 参数（chrome.storage 持久化）
 *   2) PDF：pdf.js 取文字层，文字不足的页面渲染成 canvas 再 OCR
 *      图片：直接 OCR
 *   3) 匹配：白名单院校 + 关键词（奖学金）
 *   4) 结果渲染 + 导出 CSV
 * ========================================================================= */

import * as pdfjsLib from './vendor/pdfjs/pdf.mjs';

// tesseract.js 不同版本的打包产物导出方式不一样：
//   ① 具名导出 createWorker
//   ② 只导出 default（对象里带 createWorker）
//   ③ UMD 格式，挂到全局 globalThis.Tesseract
// 这里三种都兼容，避免 "does not provide an export named 'createWorker'" 报错。
import * as TesseractNS from './vendor/tesseract/tesseract.esm.min.js';

const createWorker =
  TesseractNS.createWorker ||                                   // ①
  (TesseractNS.default && TesseractNS.default.createWorker) ||  // ②
  (globalThis.Tesseract && globalThis.Tesseract.createWorker);  // ③

// 如果三种都没取到，直接在页面上把原因显示出来，方便定位
if (typeof createWorker !== 'function') {
  document.body.insertAdjacentHTML('afterbegin',
    '<pre style="background:#fee;color:#900;padding:12px;margin:0;white-space:pre-wrap;font-size:12px">' +
    '❌ 没能从 vendor/tesseract/tesseract.esm.min.js 里取到 createWorker。\n' +
    '该模块导出的内容是：' + JSON.stringify(Object.keys(TesseractNS)) + '\n' +
    '请重新执行 node tools/copy_vendor.mjs，确认这个文件是从 node_modules 复制过来的正品。' +
    '</pre>');
  throw new Error('createWorker 未找到');
}

/* ---------------------------- 常量 ---------------------------- */
const KEY_SCHOOLS = 'schools';
const KEY_KEYWORD = 'keyword';
const KEY_OPTS    = 'ocrOptions';

// 内置默认白名单（可在界面里随意编辑，保存后写入 chrome.storage.local）
const DEFAULT_SCHOOLS = [
  '清华大学', '北京大学', '浙江大学', '复旦大学', '上海交通大学',
  '南京大学', '中国科学技术大学', '哈尔滨工业大学', '西安交通大学',
  '武汉大学', '华中科技大学', '中山大学', '同济大学', '东南大学',
].join('\n');

const ACCEPT_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'bmp', 'webp'];
const MIN_IMAGE_WIDTH = 1000;   // 图片过小先放大，OCR 更准
const MAX_SIDE        = 4000;   // 超大图降采样，避免内存爆掉

/* ---------------------------- 全局状态 ---------------------------- */
const S = {
  schools: [],            // 去重后的白名单（保留原样，用于显示）
  schoolKeys: [],         // 归一化后的白名单（去掉所有空白，用于匹配）
  keyword: '奖学金',
  files: [],              // [{ file, path }]
  results: [],            // 处理结果
  ocr: null,              // Tesseract worker（单实例，串行复用）
  running: false,
  cancel: false,
  opts: { dpi: 300, minChars: 20, binarize: false },
};

/* ---------------------------- DOM ---------------------------- */
const $ = (id) => document.getElementById(id);
const elWhitelist = $('whitelist'), elWlCount = $('wlCount'), elWlSaved = $('wlSaved');
const elKeyword = $('keyword'), elDpi = $('dpi'), elMinChars = $('minChars');
const elBinarize = $('binarize');
const elFileSummary = $('fileSummary'), elDropzone = $('dropzone');
const elRun = $('run'), elCancel = $('cancel'), elBar = $('bar'), elStatus = $('status');
const elStats = $('stats'), elFilter = $('filter'), elExport = $('export');
const elTbody = document.querySelector('#result tbody');
const elDetail = $('detail'), elDetailTitle = $('detailTitle'), elDetailBody = $('detailBody');

/* pdf.js 的 worker 必须指向本地文件（MV3 不允许远程脚本） */
pdfjsLib.GlobalWorkerOptions.workerSrc =
  chrome.runtime.getURL('vendor/pdfjs/pdf.worker.mjs');

/* ============================ 工具函数 ============================ */

// 统计非空白字符数（用于判断 PDF 页面是否真的有文字层）
const countVisible = (t) => (t || '').replace(/\s/g, '').length;

// ── 文本归一化：匹配前把所有空白类字符去掉 ──
// PDF 文字层和 OCR 结果里常见的"隐形字符"：半角空格、换行、
// 全角空格(U+3000)、不换行空格(U+00A0)、零宽字符(U+200B~U+200D/U+FEFF)。
// 「清 华 大 学」这类结果就是被它们拆开导致 includes() 匹配失败的。
const INVISIBLE_RE      = /[\s\u3000\u00A0\u200B-\u200D\uFEFF]/g;
const TRIM_INVISIBLE_RE = /^[\s\u3000\u00A0\u200B-\u200D\uFEFF]+|[\s\u3000\u00A0\u200B-\u200D\uFEFF]+$/g;

// 归一化 = Unicode NFKC + 剥离空白/隐形字符
//
// NFKC 负责解决"同形异码"：屏幕上长得一样、码点却不同的字符统一成标准形式：
//    ⼤ U+2F24（康熙部首）      →  大 U+5927
//    ⾔ U+2F54                 →  言 U+8A00
//    學 U+F900 等兼容汉字        →  学 U+5B66
//    ＡＢＣ１２３（全角字母数字） →  ABC123
// 这在处理中文 PDF 时非常关键——某些嵌入字体会把汉字映射到康熙部首区。
const stripInvisible = (s) => String(s ?? '').normalize('NFKC').replace(INVISIBLE_RE, '');
const trimInvisible  = (s) => String(s ?? '').normalize('NFKC').replace(TRIM_INVISIBLE_RE, '');


// 压成单行并按“字符”截断（用 Array.from 保证不切坏汉字/emoji）
function makeSnippet(text, maxChars = 300) {
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') + '…' : flat;
}

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ============================ 初始化 ============================ */

async function init() {
  const st = await chrome.storage.local.get({
    [KEY_SCHOOLS]: DEFAULT_SCHOOLS,
    [KEY_KEYWORD]: '奖学金',
    [KEY_OPTS]: null,
  });
  elWhitelist.value = st[KEY_SCHOOLS];
  elKeyword.value   = st[KEY_KEYWORD];
  if (st[KEY_OPTS]) S.opts = { ...S.opts, ...st[KEY_OPTS] };
  elDpi.value = S.opts.dpi;
  elMinChars.value = S.opts.minChars;
  elBinarize.checked = S.opts.binarize;

  syncWhitelistFromTextarea();
  syncOptions();
  setStatus('就绪。选择简历文件后点击「开始筛选」。');
}

// 把 textarea 内容解析成白名单数组（去空行、去注释、去重）
// 同时生成一份"归一化"的副本，专供匹配使用
function syncWhitelistFromTextarea() {
  const seen = new Set();
  S.schools = [];
  S.schoolKeys = [];

  elWhitelist.value.split('\n').forEach((raw) => {
    const name = trimInvisible(raw);        // 去掉首尾空白/全角空格/零宽字符
    if (!name || name.startsWith('#')) return;
    const key = stripInvisible(name);       // 去掉内部所有空白后作为匹配键
    if (!key || seen.has(key)) return;      // 同一所院校只保留一条
    seen.add(key);
    S.schools.push(name);                   // 显示用：保留原始写法
    S.schoolKeys.push(key);                 // 匹配用：紧凑形式
  });

  elWlCount.textContent = `${S.schools.length} 所`;
}


function syncOptions() {
  S.keyword = elKeyword.value.trim() || '奖学金';
  S.opts = {
    dpi: Math.min(600, Math.max(100, Number(elDpi.value) || 300)),
    minChars: Math.max(0, Number(elMinChars.value) || 20),
    binarize: elBinarize.checked,
  };
}

/* ============================ OCR 引擎 ============================ */

/**
 * 由于我们显式指定了 core 文件，这里先探测存在哪个（不同版本 tesseract.js-core 文件名不同）
 * 优先用 LSTM + SIMD 版本：体积最小、速度最快，与 oem=1 匹配。
 */
async function pickCorePath() {
  const candidates = [
    'tesseract-core-simd-lstm.wasm.js',
    'tesseract-core-lstm.wasm.js',
    'tesseract-core-simd.wasm.js',
    'tesseract-core.wasm.js',
  ];
  for (const name of candidates) {
    const url = chrome.runtime.getURL('vendor/tesseract/' + name);
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) return url;
    } catch (_) { /* 继续尝试下一个 */ }
  }
  return null;
}

/** 懒加载并复用 OCR worker（初始化要 5~15 秒，绝不能每份简历都建一次） */
async function ensureOcr() {
  if (S.ocr) return S.ocr;

  setStatus('正在初始化 OCR 引擎（首次需加载语言包并编译 wasm，请稍候）…');
  const corePath = await pickCorePath();
  if (!corePath) {
    throw new Error('未找到 tesseract-core-*.wasm.js，请先执行 tools/copy_vendor.mjs');
  }

  S.ocr = await createWorker(['chi_sim', 'eng'], 1 /* OEM = LSTM_ONLY */, {
    workerPath: chrome.runtime.getURL('vendor/tesseract/worker.min.js'),
    corePath,
    langPath:   chrome.runtime.getURL('tessdata/'),
    // 关键：不要用 blob URL 创建 worker，MV3 的 CSP 会拦；直接用扩展内 URL 即可
    workerBlobURL: false,
    cacheMethod: 'indexeddb',        // 语言包缓存到 IndexedDB，第二次打开秒进
    logger: (m) => {
      if (m.status === 'loading language traineddata') setSubProgress(m.progress, '加载语言包');
      else if (m.status === 'initializing api')       setSubProgress(m.progress, '初始化 OCR');
      else if (m.status === 'recognizing text')       setSubProgress(m.progress, '识别中');
    },
    errorHandler: (e) => console.error('[tesseract]', e),
  });
  setStatus('OCR 引擎就绪。');
  return S.ocr;
}

/** OCR 前的图像预处理：灰度 +（可选）Otsu 二值化，直接在 canvas 上原地改 */
function preprocessCanvas(canvas, binarize) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;

  // 1) 转灰度
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = d[i + 1] = d[i + 2] = g;
  }

  // 2) Otsu 求最佳阈值后二值化（扫描件偏灰、有底纹时效果明显）
  if (binarize) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
    const total = canvas.width * canvas.height;
    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * hist[v];

    let sumB = 0, wB = 0, maxVar = 0, threshold = 127;
    for (let v = 0; v < 256; v++) {
      wB += hist[v];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += v * hist[v];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVar) { maxVar = between; threshold = v; }
    }
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] > threshold ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** 识别一张 canvas，返回 UTF-8 文本 */
async function ocrCanvas(canvas) {
  const worker = await ensureOcr();
  if (S.opts.binarize) preprocessCanvas(canvas, true);
  const { data } = await worker.recognize(canvas);
  return data.text || '';
}

/** 图片文件 → canvas（自动放大/缩小）→ OCR */
async function ocrImageBlob(blob) {
  const bitmap = await createImageBitmap(blob);   // 浏览器原生解码，比 Image 更快
  let scale = 1;
  if (bitmap.width < MIN_IMAGE_WIDTH) scale = MIN_IMAGE_WIDTH / bitmap.width;
  const maxSide = Math.max(bitmap.width, bitmap.height) * scale;
  if (maxSide > MAX_SIDE) scale *= MAX_SIDE / maxSide;

  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(bitmap.width  * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';                      // PNG 透明底铺白，否则 OCR 认不出
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const text = await ocrCanvas(canvas);
  canvas.width = canvas.height = 0;               // 主动释放内存
  return text;
}

/* ============================ PDF 提取 ============================ */

async function extractPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,                 // 关掉 new Function，彻底躲开 CSP 争议
    // 中文 PDF 常用 CID 字体，必须提供 cmaps，否则会提取出空白或乱码
    cMapUrl: chrome.runtime.getURL('vendor/pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('vendor/pdfjs/standard_fonts/'),
  });
  const pdf = await loadingTask.promise;

  const pageTexts = [];
  let ocrPages = 0;

  for (let p = 1; p <= pdf.numPages; p++) {
    if (S.cancel) break;
    updateSubStatus(`第 ${p}/${pdf.numPages} 页`);
    const page = await pdf.getPage(p);

    // ---- (1) 先取文字层 ----
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (typeof item.str === 'string') text += item.str;
      if (item.hasEOL) text += '\n';
    }

    if (countVisible(text) >= S.opts.minChars) {
      pageTexts.push(text);                          // 文本型页面，直接用
      page.cleanup();
      continue;
    }

    // ---- (2) 文字太少 → 判定为扫描页，渲染后 OCR ----
    const base = page.getViewport({ scale: 1 });
    let scale = S.opts.dpi / 72;
    const maxSide = Math.max(base.width, base.height) * scale;
    if (maxSide > MAX_SIDE) scale *= MAX_SIDE / maxSide;   // 防止超大页面 OOM

    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width  = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;

    pageTexts.push(await ocrCanvas(canvas));
    ocrPages++;

    canvas.width = canvas.height = 0;                // 逐页释放，大 PDF 才撑得住
    page.cleanup();
  }

  await loadingTask.destroy();                       // 释放 pdf.js 文档与 worker 资源
  return { text: pageTexts.join('\n'), ocrPages };
}

/* ============================ 匹配 ============================ */

function matchText(rawText) {
  // 关键：先把简历文本归一化（去掉空格/换行/全角空格/零宽字符并统一小写），
  // 再和白名单的归一化形式比较，避免「清 华 大 学」这类识别结果匹配失败
  const hay = stripInvisible(rawText).toLowerCase();

  const schools = [];
  S.schools.forEach((name, i) => {
    const key = S.schoolKeys[i].toLowerCase();
    if (key && hay.includes(key)) schools.push(name);
  });

  return {
    schools,
    qualified: schools.length > 0,
    scholarship: hay.includes(stripInvisible(S.keyword).toLowerCase()),
  };
}

/* ============================ 文件收集 ============================ */

const extOf = (name) => (name.split('.').pop() || '').toLowerCase();

function addFiles(entries) {
  const existed = new Set(S.files.map((f) => f.path + '|' + f.file.size));
  let added = 0;
  const skipped = [];                     // 记录被跳过的文件，用于给出准确提示

  for (const { file, path } of entries) {
    const ext = extOf(path);
    if (!ACCEPT_EXT.includes(ext)) {
      skipped.push(path);                 // 格式不支持 → 记下来，稍后提示
      continue;
    }
    const key = path + '|' + file.size;
    if (existed.has(key)) continue;       // 重复文件不重复加入
    existed.add(key);
    S.files.push({ file, path });
    added++;
  }
  renderFileSummary(added, skipped);
}

function renderFileSummary(added = 0, skipped = []) {
  const n = S.files.length;
  const size = S.files.reduce((a, f) => a + f.file.size, 0) / 1024 / 1024;

  // 一个文件都没有时，只显示支持的格式说明
  if (n === 0) {
    elFileSummary.textContent = '尚未选择文件。支持 PDF / JPG / PNG / BMP / WEBP。';
    return;
  }

  let text = `已选 ${n} 个文件（约 ${size.toFixed(1)} MB）`
           + (added ? `，新增 ${added} 个。` : '。');

  // 只有在确实跳过了文件时才提示，并且说明是哪些格式
  if (skipped.length) {
    const exts = [...new Set(skipped.map(extOf))].map((e) => '.' + e).join('、');
    text += ` ⚠️ 已跳过 ${skipped.length} 个格式不支持的文件（${exts}）。`;
    if (skipped.some((p) => /\.tiff?$/i.test(p))) {
      text += '浏览器无法解码 TIFF，请先转成 PNG 或 JPG。';
    }
  }
  elFileSummary.textContent = text;
}


/* ============================ 处理流水线 ============================ */

async function processOne(entry) {
  const t0 = performance.now();
  const ext = extOf(entry.path);

  let text = '', ocrPages = 0;
  if (ext === 'pdf') {
    ({ text, ocrPages } = await extractPdf(entry.file));
  } else {
    text = await ocrImageBlob(entry.file);
    ocrPages = 1;
  }

  const m = matchText(text);
  return {
    name: entry.path,
    ...m,
    text,
    snippet: makeSnippet(text, 300),
    usedOcr: ocrPages > 0,
    note: ocrPages > 0 ? `OCR ${ocrPages} 页` : '文本层直接提取',
    ms: Math.round(performance.now() - t0),
    ok: true,
  };
}

async function run() {
  if (S.running) return;
  if (!S.files.length) { alert('请先选择简历文件'); return; }
  if (!S.schools.length) { alert('白名单为空，请先填写院校名称'); return; }

  S.running = true; S.cancel = false;
  S.results = [];
  elTbody.innerHTML = '';
  elRun.disabled = true; elCancel.disabled = false; elExport.disabled = true;
  elStats.hidden = false;
  updateStats();

  try {
    await ensureOcr();                       // 先初始化，避免第一次识别超时
    for (let i = 0; i < S.files.length; i++) {
      if (S.cancel) break;
      const entry = S.files[i];
      setProgress(i / S.files.length, `正在处理 ${i + 1}/${S.files.length}：${entry.path}`);

      let res;
      try {
        res = await processOne(entry);
      } catch (e) {
        console.error(e);
        res = {
          name: entry.path, schools: [], qualified: false, scholarship: false,
          text: '', snippet: '[提取失败] ' + (e?.message || e), usedOcr: false,
          note: '提取失败', ms: 0, ok: false,
        };
      }
      S.results.push(res);
      appendRow(S.results.length - 1, res);
      updateStats();
      await new Promise((r) => setTimeout(r, 0));   // 让出主线程，界面不冻结
    }
    setProgress(1, S.cancel ? '已停止' : `完成，共处理 ${S.results.length} 份`);
  } catch (e) {
    console.error(e);
    setStatus('出错了：' + (e?.message || e));
  } finally {
    S.running = false;
    elRun.disabled = false; elCancel.disabled = true;
    elExport.disabled = S.results.length === 0;
  }
}

/* ============================ 结果渲染 ============================ */

function verdictHtml(ok) {
  return ok ? '<span class="yes">是</span>' : '<span class="no">否</span>';
}

function buildRow(index, r) {
  const tr = document.createElement('tr');
  tr.dataset.index = String(index);

  const schoolsHtml = r.schools.length
    ? r.schools.map((s) => `<mark>${escapeHtml(s)}</mark>`).join('、')
    : '<span style="color:#9aa1a9">—</span>';

  tr.innerHTML = `
    <td>${index + 1}</td>
    <td>${escapeHtml(r.name)}</td>
    <td>${schoolsHtml}</td>
    <td>${verdictHtml(r.qualified)}</td>
    <td>${verdictHtml(r.scholarship)}</td>
    <td class="snippet ${r.ok ? '' : 'fail'}" title="点击查看全文">${escapeHtml(r.snippet)}</td>`;

  tr.querySelector('td.snippet').addEventListener('click', () => {
    elDetailTitle.textContent = r.name;
    // 全文里把命中的院校高亮出来，方便人工核对
    let html = escapeHtml(r.text || r.snippet);
    for (const s of r.schools) {
      html = html.split(escapeHtml(s)).join(`<mark>${escapeHtml(s)}</mark>`);
    }
    elDetailBody.innerHTML = html || '（无文本）';
    elDetail.showModal();
  });
  return tr;
}

function appendRow(index, r) {
  elTbody.appendChild(buildRow(index, r));
}

function applyFilter() {
  const mode = elFilter.value;
  elTbody.innerHTML = '';
  S.results.forEach((r, i) => {
    const keep =
      mode === 'all' ||
      (mode === 'qualified' && r.qualified) ||
      (mode === 'scholar' && r.scholarship) ||
      (mode === 'both' && r.qualified && r.scholarship) ||
      (mode === 'fail' && !r.ok);
    if (keep) elTbody.appendChild(buildRow(i, r));
  });
}

function updateStats() {
  $('sTotal').textContent     = S.results.length;
  $('sQualified').textContent = S.results.filter((r) => r.qualified).length;
  $('sScholar').textContent   = S.results.filter((r) => r.scholarship).length;
  $('sFail').textContent      = S.results.filter((r) => !r.ok).length;
  $('sOcr').textContent       = S.results.filter((r) => r.usedOcr).length;
}

/* ============================ 状态显示 ============================ */

function setStatus(text) { elStatus.textContent = text; }
function setProgress(ratio, text) {
  elBar.style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
  if (text) setStatus(text);
}
function setSubProgress(p, label) { elBar.style.width = (p * 100).toFixed(1) + '%'; }
function updateSubStatus(text) { setStatus(text); }

/* ============================ 导出 CSV ============================ */

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCsv() {
  if (!S.results.length) return;
  const header = ['文件名', '匹配院校', '院校是否合格', '是否含奖学金', '简历文本片段', '备注', '耗时(ms)'];
  const lines = [header];
  for (const r of S.results) {
    lines.push([
      r.name,
      r.schools.join('、'),
      r.qualified ? '是' : '否',
      r.scholarship ? '是' : '否',
      r.snippet,
      r.note,
      r.ms,
    ]);
  }
  const csv = lines.map((l) => l.map(csvEscape).join(',')).join('\r\n');
  // \uFEFF 是 UTF-8 BOM，没有它 Excel 打开中文会乱码
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `简历筛选结果_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/* ============================ 事件绑定 ============================ */

// —— 白名单 ——
elWhitelist.addEventListener('input', syncWhitelistFromTextarea);
$('saveWhitelist').addEventListener('click', async () => {
  syncWhitelistFromTextarea();
  await chrome.storage.local.set({ [KEY_SCHOOLS]: elWhitelist.value });
  elWlSaved.textContent = '已保存 ✓';
  setTimeout(() => (elWlSaved.textContent = ''), 1500);
});
$('resetWhitelist').addEventListener('click', () => {
  elWhitelist.value = DEFAULT_SCHOOLS;
  syncWhitelistFromTextarea();
});
$('importWhitelist').addEventListener('click', () => $('wlFile').click());
$('wlFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  elWhitelist.value = await f.text();       // File.text() 按 UTF-8 解码
  syncWhitelistFromTextarea();
  e.target.value = '';
});

// —— 参数 ——
[elKeyword, elDpi, elMinChars, elBinarize].forEach((el) =>
  el.addEventListener('change', async () => {
    syncOptions();
    await chrome.storage.local.set({
      [KEY_KEYWORD]: elKeyword.value,
      [KEY_OPTS]: S.opts,
    });
  }));

// —— 选文件 ——
$('pickFiles').addEventListener('click', () => $('fileInput').click());
$('pickDir').addEventListener('click', () => $('dirInput').click());
$('fileInput').addEventListener('change', (e) => {
  addFiles([...e.target.files].map((f) => ({ file: f, path: f.name })));
  e.target.value = '';
});
$('dirInput').addEventListener('change', (e) => {
  // webkitRelativePath 形如 "简历库/张三.pdf"
  addFiles([...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
  e.target.value = '';
});
$('clearFiles').addEventListener('click', () => {
  S.files = []; S.results = []; elTbody.innerHTML = '';
  elStats.hidden = true; elExport.disabled = true;
  renderFileSummary();
});

// —— 拖放 ——
['dragenter', 'dragover'].forEach((ev) =>
  elDropzone.addEventListener(ev, (e) => {
    e.preventDefault(); elDropzone.classList.add('over');
  }));
['dragleave', 'drop'].forEach((ev) =>
  elDropzone.addEventListener(ev, (e) => {
    e.preventDefault(); elDropzone.classList.remove('over');
  }));
elDropzone.addEventListener('drop', async (e) => {
  const entries = [];
  const items = [...(e.dataTransfer.items || [])];
  for (const item of items) {
    // 支持拖入文件夹（递归遍历）
    const handle = item.webkitGetAsEntry?.();
    if (handle) await walkEntry(handle, '', entries);
  }
  if (!entries.length) {
    for (const f of e.dataTransfer.files) entries.push({ file: f, path: f.name });
  }
  addFiles(entries);
});

// 递归读取拖入的目录（FileSystemEntry 是老 API，但拖放场景最方便）
async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: prefix + entry.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    const readBatch = () =>
      new Promise((res) => reader.readEntries(res, () => res([])));
    let batch;
    do {
      batch = await readBatch();
      for (const child of batch) await walkEntry(child, prefix + entry.name + '/', out);
    } while (batch.length);
  }
}

// —— 执行 / 导出 / 筛选 / 弹窗 ——
elRun.addEventListener('click', run);
elCancel.addEventListener('click', () => {
  S.cancel = true;
  setStatus('正在停止…（当前简历处理完即结束）');
});
elExport.addEventListener('click', exportCsv);
elFilter.addEventListener('change', applyFilter);
$('detailClose').addEventListener('click', () => elDetail.close());

// 页面关闭前提醒（避免误关导致任务中断）
window.addEventListener('beforeunload', (e) => {
  if (S.running) { e.preventDefault(); e.returnValue = ''; }
});

init();
