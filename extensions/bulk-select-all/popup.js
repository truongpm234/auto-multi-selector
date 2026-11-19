/* ============================================================
 * Bulk Select All - popup
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

let settings = { ...DEFAULT_SETTINGS };
let tab = null;
let host = '';
let pageSupported = false;

const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function setBusy(on) {
  document.querySelectorAll('.btn').forEach((b) => {
    if (on) b.setAttribute('disabled', '');
    else b.removeAttribute('disabled');
  });
}

async function getSettings() {
  const data = await chrome.storage.local.get('bsa');
  return { ...DEFAULT_SETTINGS, ...(data && data.bsa ? data.bsa : {}) };
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ bsa: settings });
}

function fillForm() {
  $('clickDelay').value = String(settings.clickDelay);
  $('stepDelay').value = String(settings.stepDelay);
  $('idleRounds').value = String(settings.idleRounds || 4);
  $('preferHeader').checked = settings.preferHeaderSelectAll !== false;
  $('autoScroll').checked = settings.autoScroll !== false;
  $('restoreScroll').checked = settings.restoreScroll !== false;
  $('auto').checked = (settings.autoRunHosts || []).includes(host);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

async function pingContent() {
  if (!tab || typeof tab.id !== 'number') return null;
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tab.id, { source: 'BSA', type: 'PING' }, (res) => {
        void chrome.runtime.lastError;
        resolve(res || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

async function countBoxes() {
  if (!tab || typeof tab.id !== 'number') return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: function () {
        return document.querySelectorAll(
          'input[type="checkbox"], [role="checkbox"], [aria-checked], [data-state="checked"], [data-state="unchecked"]'
        ).length;
      }
    });
    return results.reduce((sum, r) => sum + (typeof r.result === 'number' ? r.result : 0), 0);
  } catch (e) {
    return null;
  }
}

async function refreshCount() {
  const count = await countBoxes();
  if (count === null) {
    $('site').textContent = host || 'Unknown';
    return;
  }
  $('site').textContent = (host || 'Unknown') + ' · ' + count + ' checkbox' + (count === 1 ? '' : 'es');
}

function sendAction(action, options) {
  if (!pageSupported || !tab) {
    setStatus('This page does not allow injection (browser internal page).', 'warn');
    return;
  }
  setBusy(true);
  setStatus('Sending command to the page…');

  chrome.tabs.sendMessage(
    tab.id,
    { source: 'BSA', type: 'RUN', action: action, options: options || {} },
    (res) => {
      const err = chrome.runtime.lastError;
      if (err) {
        setBusy(false);
        setStatus('Could not connect to the page. Click “Reload page” and try again.', 'warn');
        return;
      }
      setBusy(false);
      if (res && res.ok) {
        const clicked = Number(res.clicked) || 0;
        const checked = Number(res.checked) || 0;
        const total = Number(res.total) || 0;
        if (action === 'clear') {
          setStatus('Unselected ' + clicked + ' item' + (clicked === 1 ? '' : 's') + '.', 'ok');
        } else if (action === 'invert') {
          setStatus('Inverted ' + clicked + ' item' + (clicked === 1 ? '' : 's') + '.', 'ok');
        } else {
          const extra = res.headerUsed
            ? ' (via the page’s “select all” box)'
            : ' (' + clicked + ' click' + (clicked === 1 ? '' : 's') + ')';
          const scrolled = Number(res.scrollPercent) === 100 ? ' · scrolled to the bottom.' : '.';
          setStatus('Selected ' + checked + '/' + total + ' item' + (total === 1 ? '' : 's') + extra + scrolled, 'ok');
        }
        setTimeout(refreshCount, 500);
      } else if (res && res.busy) {
        setStatus('The page is already running another command — try again in a moment.', 'warn');
      } else {
        setStatus('No checkboxes found on this page.', 'warn');
      }
    }
  );
}

async function init() {
  settings = await getSettings();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = tabs && tabs[0] ? tabs[0] : null;

  if (tab && tab.url) {
    try {
      const url = new URL(tab.url);
      pageSupported = /^https?:$/.test(url.protocol) || url.protocol === 'file:';
      host = url.hostname || url.protocol.replace(':', '');
    } catch (e) {
      pageSupported = false;
    }
  }

  fillForm();
  $('site').textContent = host || 'Unknown';
  $('auto').disabled = !pageSupported;

  if (!pageSupported) {
    setStatus('This is a browser internal page — the extension cannot run here.', 'warn');
    return;
  }

  const content = await pingContent();
  if (!content) {
    setStatus('This page has not loaded the extension yet. Click “Reload page” (F5), then reopen the popup.', 'warn');
    return;
  }

  await refreshCount();
  setStatus('Ready — click “Select + scroll to bottom”.', 'ok');
}

/* ------------------------- UI events ------------------------- */
document.querySelectorAll('.btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.getAttribute('data-act') || 'select';
    const scroll = btn.getAttribute('data-scroll') === '1';
    const bottom = btn.getAttribute('data-bottom') === '1';
    sendAction(action, { autoScroll: scroll, toBottom: bottom });
  });
});

$('auto').addEventListener('change', async (ev) => {
  const hosts = new Set(settings.autoRunHosts || []);
  if (ev.target.checked) hosts.add(host);
  else hosts.delete(host);
  await saveSettings({ autoRunHosts: Array.from(hosts) });
  setStatus(ev.target.checked ? 'Will auto-select when this page opens.' : 'Auto-select disabled for this page.', 'ok');
});

$('clickDelay').addEventListener('change', async (ev) => {
  const value = clampNumber(ev.target.value, 0, 500, 15);
  ev.target.value = String(value);
  await saveSettings({ clickDelay: value });
});

$('stepDelay').addEventListener('change', async (ev) => {
  const value = clampNumber(ev.target.value, 100, 3000, 350);
  ev.target.value = String(value);
  await saveSettings({ stepDelay: value });
});

$('idleRounds').addEventListener('change', async (ev) => {
  const value = clampNumber(ev.target.value, 1, 20, 4);
  ev.target.value = String(value);
  await saveSettings({ idleRounds: value });
});

$('preferHeader').addEventListener('change', (ev) => saveSettings({ preferHeaderSelectAll: ev.target.checked }));
$('autoScroll').addEventListener('change', (ev) => saveSettings({ autoScroll: ev.target.checked }));
$('restoreScroll').addEventListener('change', (ev) => saveSettings({ restoreScroll: ev.target.checked }));

$('showPanel').addEventListener('click', () => {
  if (!pageSupported || !tab) return;
  chrome.tabs.sendMessage(tab.id, { source: 'BSA', type: 'SHOW_PANEL' }, () => {
    void chrome.runtime.lastError;
    window.close();
  });
});

$('reload').addEventListener('click', () => {
  if (!tab || typeof tab.id !== 'number') return;
  chrome.tabs.reload(tab.id);
  window.close();
});

init();
