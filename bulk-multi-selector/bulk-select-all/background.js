/* ============================================================
 * Bulk Select All - background service worker (Manifest V3)
 * - Seeds default settings on install
 * - Relays panel/popup commands to EVERY frame of the tab
 * - Handles the Alt+Shift+A shortcut
 * ============================================================ */

const DEFAULT_SETTINGS = {
  autoScroll: true,
  preferHeaderSelectAll: true,
  restoreScroll: true,
  clickDelay: 15,
  stepDelay: 350,
  maxDuration: 120000,
  idleRounds: 4,
  maxSteps: 800,
  scrollStepPct: 0.85,
  autoRunHosts: [],
  autoRunDelay: 1000,
  autoRunWait: 15000,
  panelPos: null,
  panelCollapsed: false
};

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.local.get('bsa');
  if (!stored || !stored.bsa) {
    await chrome.storage.local.set({ bsa: { ...DEFAULT_SETTINGS } });
  }
  if (details.reason === 'install') {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    } catch (e) {
      /* bỏ qua */
    }
  }
});

/** Gửi lệnh chạy tới tất cả frame của tab. */
function runInTab(tabId, action, options) {
  return chrome.tabs
    .sendMessage(tabId, {
      source: 'BSA',
      type: 'RUN',
      action: action,
      options: options || {}
    })
    .catch(() => null);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.source !== 'BSA') return;

  /* Panel nổi (content script ở frame top) nhờ background phát lệnh cho mọi frame */
  if (msg.type === 'BROADCAST') {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== 'number') {
      sendResponse({ ok: false, error: 'no-tab' });
      return;
    }
    runInTab(tabId, msg.action, msg.options).then(() => sendResponse({ ok: true }));
    return true;
  }

  /* Mở panel nổi từ popup */
  if (msg.type === 'OPEN_PANEL') {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== 'number') {
      sendResponse({ ok: false, error: 'no-tab' });
      return;
    }
    chrome.tabs
      .sendMessage(tabId, { source: 'BSA', type: 'SHOW_PANEL' })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false, error: 'not-injected' }));
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'bsa-select-all') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== 'number') return;
  await runInTab(tab.id, 'select', {});
});

/* Cho phép người dùng bấm icon khi popup bị đóng đột ngột - không cần xử lý thêm */
