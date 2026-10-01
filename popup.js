// popup.js —— 弹窗只做两件事：显示白名单数量 + 打开工作台页面
const KEY_SCHOOLS = 'schools';

// 读取已保存的白名单，仅用于展示数量
const stored = await chrome.storage.local.get([KEY_SCHOOLS]);
const list = (stored[KEY_SCHOOLS] || '')
  .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
document.getElementById('meta').textContent = `白名单：${list.length} 所院校`;

// 打开 app.html。必须用新标签页：
// popup 一关闭，里面的 JS 上下文就销毁了，长任务不能放在弹窗里跑。
document.getElementById('open').addEventListener('click', async () => {
  const url = chrome.runtime.getURL('app.html');
  const [tab] = await chrome.tabs.query({ url });   // 已开则复用，避免开一堆
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
});
