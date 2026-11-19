/* ============================================================
 * Bulk Select All - content script (runs in EVERY frame)
 *
 * - Finds the page's checkboxes (input[type=checkbox], role=checkbox, aria-checked)
 * - Tries the page's own "Select all" header box first (verified by result)
 * - Fallback: click each checkbox (React/Vue/Angular friendly)
 * - Auto-scrolls to select long / virtualized / lazily loaded lists
 * - Draggable floating panel built in Shadow DOM (page CSS cannot break it)
 * ============================================================ */
(() => {
  'use strict';

  if (window.__BSA_CONTENT__) return;
  window.__BSA_CONTENT__ = true;

  const IS_TOP = (() => {
    try {
      return window.top === window;
    } catch (e) {
      return false;
    }
  })();

  const FRAME_ID = Math.random().toString(36).slice(2, 9);

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
  let busy = false;
  let autoRunTimer = null;
  let autoRunStarted = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* ------------------------------------------------------------
   * Cài đặt (storage.local, dùng chung với popup)
   * ---------------------------------------------------------- */
  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('bsa', (data) => {
          if (data && data.bsa) settings = { ...DEFAULT_SETTINGS, ...data.bsa };
          resolve(settings);
        });
      } catch (e) {
        resolve(settings);
      }
    });
  }

  function saveSettings(patch) {
    settings = { ...settings, ...patch };
    try {
      chrome.storage.local.set({ bsa: settings });
    } catch (e) {
      /* bỏ qua */
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.bsa) return;
    settings = { ...DEFAULT_SETTINGS, ...(changes.bsa.newValue || {}) };
    if (IS_TOP) syncPanelSettings();
  });

  /** Danh sách hostname: host của frame + host của các trang cha (Chromium). */
  function hostList() {
    const hosts = new Set();
    try {
      if (location.hostname) hosts.add(location.hostname);
    } catch (e) {
      /* bỏ qua */
    }
    try {
      const origins = location.ancestorOrigins || [];
      for (let i = 0; i < origins.length; i++) {
        try {
          hosts.add(new URL(origins[i]).hostname);
        } catch (e) {
          /* bỏ qua */
        }
      }
    } catch (e) {
      /* bỏ qua */
    }
    return Array.from(hosts).filter(Boolean);
  }

  /* ------------------------------------------------------------
   * Phát hiện & thao tác checkbox
   * ---------------------------------------------------------- */
  const CHECKBOX_SELECTOR = [
    'input[type="checkbox"]',
    '[role="checkbox"]',
    '[aria-checked]',
    '[data-state="checked"]',
    '[data-state="unchecked"]'
  ].join(',');

  const BAD_ROLES = /^(radio|tab|option|menuitemradio|switch|treeitem|menuitem)$/i;

  function detectCheckboxes() {
    const nodes = document.querySelectorAll(CHECKBOX_SELECTOR);
    const list = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.tagName === 'INPUT' && el.type !== 'checkbox') continue;
      if (BAD_ROLES.test(el.getAttribute('role') || '')) continue;
      if (el.closest('select, [role="listbox"], [role="tablist"], [role="radiogroup"]')) continue;
      /* bỏ wrapper chứa checkbox bên trong */
      if (!(el instanceof HTMLInputElement) && el.querySelector('input[type="checkbox"]')) continue;
      list.push(el);
    }
    /* Loại phần tử lồng nhau: bỏ wrapper chứa một checkbox khác bên trong */
    return list.filter((el) => !list.some((other) => other !== el && el.contains(other)));
  }

  function isChecked(el) {
    if (el instanceof HTMLInputElement) return !!el.checked;
    const ac = el.getAttribute('aria-checked');
    if (ac !== null && ac !== '') return ac === 'true' || ac === 'mixed';
    const ds = el.getAttribute('data-state');
    if (ds) return ds === 'checked' || ds === 'indeterminate';
    const as = el.getAttribute('aria-selected');
    if (as !== null && as !== '') return as === 'true';
    const cls = typeof el.className === 'string' ? el.className : '';
    return /(^|[\s_-])(is-)?(checked|selected|active)([\s_-]|$)/i.test(cls);
  }

  function isDisabled(el) {
    if (el.disabled === true) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (el.closest('fieldset[disabled]')) return true;
    const cs = getComputedStyle(el);
    return cs.pointerEvents === 'none' && cs.display === 'none';
  }

  /** Bấm checkbox theo cách "người dùng thật" để framework nhận được event. */
  function setChecked(el, want) {
    if (isDisabled(el)) return false;
    if (isChecked(el) === want) return true;

    try {
      el.click();
    } catch (e) {
      /* bỏ qua */
    }
    if (isChecked(el) === want) return true;

    /* Một số component custom không phản hồi .click() -> bắn chuỗi mouse event */
    try {
      let r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        const host = el.closest('label, [role="checkbox"], td, li, div') || el;
        r = host.getBoundingClientRect();
      }
      const base = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2
      };
      el.dispatchEvent(new MouseEvent('pointerdown', base));
      el.dispatchEvent(new MouseEvent('mousedown', base));
      el.dispatchEvent(new MouseEvent('pointerup', base));
      el.dispatchEvent(new MouseEvent('mouseup', base));
      el.dispatchEvent(new MouseEvent('click', base));
    } catch (e) {
      /* bỏ qua */
    }
    return isChecked(el) === want;
  }

  function accessibleName(el) {
    const parts = [];
    const push = (v) => {
      if (v) parts.push(String(v));
    };
    push(el.getAttribute('aria-label'));
    push(el.getAttribute('title'));
    push(el.getAttribute('name'));
    push(el.getAttribute('data-testid'));
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      labelledBy.split(/\s+/).forEach((id) => {
        const node = document.getElementById(id);
        if (node) push(node.textContent);
      });
    }
    const label = el.closest('label');
    if (label) push(label.textContent);
    const th = el.closest('th, [role="columnheader"]');
    if (th) push(th.textContent);
    const td = el.closest('td');
    if (td) push(td.textContent);
    return parts.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function looksLikeSelectAll(el) {
    const name = accessibleName(el);
    if (!name) return false;
    if (/(select|chọn|chon|check)\s*(all|tất cả|tat ca)/i.test(name)) return true;
    if (/tất cả|tat ca/i.test(name)) return true;
    if (/(^|\s)all(\s|$)/i.test(name) && name.length <= 32) return true;
    /* ô header chỉ ghi đúng chữ "Select" / "Chọn" */
    if (/^(select|chọn|chon)$/i.test(name)) return true;
    return false;
  }

  /** Ô "Select all" nhận diện được qua tên (aria-label, label, header text...). */
  function findSelectAllBox(boxes) {
    return boxes.filter(looksLikeSelectAll)[0] || null;
  }

  /** Ứng viên "Select all": ưu tiên theo tên, sau đó theo vị trí trong header của bảng. */
  function findHeaderCandidate(boxes) {
    const byName = findSelectAllBox(boxes);
    if (byName) return byName;
    const inHeader = boxes.filter((el) =>
      el.closest('th, thead, [role="columnheader"], header, [class*="header" i], [class*="toolbar" i]')
    );
    if (inHeader.length >= 1 && boxes.length > inHeader.length) {
      /* ưu tiên ô nằm cao nhất (thường là header) */
      inHeader.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      return inHeader[0];
    }
    return null;
  }

  /* ------------------------------------------------------------
   * Tìm vùng cuộn & chạy chọn hàng loạt
   * ---------------------------------------------------------- */
  function publish(payload) {
    const msg = {
      source: 'BSA',
      kind: 'state',
      frameId: FRAME_ID,
      frameHost: (() => {
        try {
          return location.hostname;
        } catch (e) {
          return '';
        }
      })(),
      ...payload
    };
    if (IS_TOP) {
      handleStateMessage(msg);
    } else {
      try {
        window.top.postMessage(msg, '*');
      } catch (e) {
        /* bỏ qua */
      }
    }
  }

  /**
   * Tìm vùng cuộn cần điều khiển.
   * - Ưu tiên container SÂU NHẤT có chứa checkbox (danh sách ảnh/file).
   * - Nếu không có thì lấy container cuộn lớn nhất.
   * - Cuối cùng mới dùng vùng cuộn của cả trang (window / documentElement).
   */
  function findScroller() {
    const docEl = document.scrollingElement || document.documentElement;
    const viewportH = window.innerHeight || docEl.clientHeight;

    /* Đánh dấu mọi tổ tiên của checkbox để biết container nào "giữ" checkbox */
    const holders = new WeakSet();
    try {
      const boxes = detectCheckboxes();
      for (let i = 0; i < boxes.length; i++) {
        let parent = boxes[i].parentElement;
        let depth = 0;
        while (parent && depth++ < 60) {
          holders.add(parent);
          parent = parent.parentElement;
        }
      }
    } catch (e) {
      /* bỏ qua */
    }

    const nodes = document.querySelectorAll(
      'div, main, section, article, ul, ol, table, tbody, [role="main"], [role="list"], [role="grid"], [class*="scroll" i], [class*="list" i], [class*="table" i]'
    );
    const limit = Math.min(nodes.length, 5000);
    let holdEl = null;
    let holdDepth = -1;
    let anyEl = null;
    let anyScore = 0;

    for (let i = 0; i < limit; i++) {
      const el = nodes[i];
      const diff = el.scrollHeight - el.clientHeight;
      if (diff < 80) continue;
      if (el.clientHeight < 80) continue;
      const cs = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(cs.overflowY)) continue;

      if (holders.has(el)) {
        let depth = 0;
        let p = el;
        while (p) {
          depth++;
          p = p.parentElement;
        }
        if (depth > holdDepth) {
          holdDepth = depth;
          holdEl = el;
        }
      }

      const score = diff * Math.min(el.clientHeight, viewportH);
      if (score > anyScore) {
        anyScore = score;
        anyEl = el;
      }
    }

    if (holdEl) return holdEl;
    if (anyEl) return anyEl;
    if (docEl && docEl.scrollHeight - docEl.clientHeight > 80) return docEl;
    return null;
  }

  function scrollTopOf(el) {
    return el ? Number(el.scrollTop) || 0 : 0;
  }

  function maxTopOf(el) {
    return el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
  }

  /** Bấm thử ô "Select all" ở header. Trả về true nếu trang thực sự chọn các dòng. */
  async function tryHeaderSelectAll(cfg) {
    const boxes = detectCheckboxes();
    if (boxes.length < 2) return false;
    const header = findHeaderCandidate(boxes);
    if (!header || isChecked(header)) return false;
    const rows = boxes.filter((b) => b !== header);
    if (!rows.length) return false;

    const before = rows.filter(isChecked).length;
    if (!setChecked(header, true)) return false;
    await sleep(Math.max(450, Number(cfg.clickDelay) || 0));

    const afterBoxes = detectCheckboxes();
    const afterRows = afterBoxes.filter((b) => b !== header);
    const after = afterRows.filter(isChecked).length;
    if (after > before) return true;

    /* Bấm vào header không có tác dụng -> hoàn tác để không làm loạn trạng thái */
    if (isChecked(header) && after === 0) setChecked(header, false);
    return false;
  }

  /** Bấm ô "Select all" (đang tick) để bỏ chọn toàn bộ. */
  async function tryHeaderClear(cfg) {
    const boxes = detectCheckboxes();
    const header = findHeaderCandidate(boxes);
    if (!header || !isChecked(header)) return false;
    const rows = boxes.filter((b) => b !== header);
    if (!rows.length) return false;
    const before = rows.filter(isChecked).length;
    if (before === 0) return false;
    if (!setChecked(header, false)) return false;
    await sleep(Math.max(450, Number(cfg.clickDelay) || 0));
    const after = detectCheckboxes()
      .filter((b) => b !== header)
      .filter(isChecked).length;
    return after < before;
  }

  /**
   * Vừa chọn vừa cuộn tới CUỐI danh sách.
   * - Tự bám theo container chứa checkbox (kể cả khi list virtualized đổi element).
   * - Chờ lazy-load: mỗi khi chiều cao tăng thì tiếp tục cuộn.
   * - Dừng khi tới đáy và chiều cao không đổi trong `idleRounds` vòng liên tiếp.
   * - onScrollInfo({ percent, steps, atBottom }) để UI hiển thị tiến độ.
   */
  async function autoScrollLoop(clickPass, deadline, cfg, onScrollInfo) {
    let target = findScroller();
    if (!target) {
      if (onScrollInfo) onScrollInfo({ percent: 100, steps: 0, atBottom: true });
      return { scrolled: false, steps: 0, percent: 100 };
    }

    const originalTop = scrollTopOf(target);
    const idleNeeded = Math.max(1, Number(cfg.idleRounds) || 4);
    const maxSteps = Math.max(10, Number(cfg.maxSteps) || 800);
    const stepPct = Math.min(1, Math.max(0.2, Number(cfg.scrollStepPct) || 0.85));

    let idle = 0;
    let steps = 0;
    let percent = 0;
    let lastHeight = target.scrollHeight;

    while (Date.now() < deadline && steps < maxSteps) {
      steps++;

      /* List virtualized có thể thay element khi re-render -> tìm lại */
      if (!target.isConnected) {
        const again = findScroller();
        if (!again) break;
        target = again;
        lastHeight = target.scrollHeight;
      }

      let maxTop = maxTopOf(target);
      const before = scrollTopOf(target);
      const stepPx = Math.max(220, Math.round(target.clientHeight * stepPct));
      target.scrollTop = Math.min(before + stepPx, maxTop);

      await sleep(Math.max(60, Number(cfg.stepDelay) || 350));
      await clickPass();

      if (!target.isConnected) continue;

      /* Nếu sát đáy thì ép xuống đáy tuyệt đối để kích hoạt lazy-load */
      maxTop = maxTopOf(target);
      if (maxTop - target.scrollTop <= 2 && target.scrollTop < maxTop) target.scrollTop = maxTop;

      const moved = Math.abs(scrollTopOf(target) - before) > 1;
      const grew = target.scrollHeight > lastHeight + 2;
      lastHeight = target.scrollHeight;
      const atBottom = scrollTopOf(target) >= maxTopOf(target) - 2;
      percent = maxTop > 0 ? Math.min(100, Math.round((scrollTopOf(target) / maxTop) * 100)) : 100;

      if (onScrollInfo) onScrollInfo({ percent, steps, atBottom });

      if (grew) idle = 0;
      else if (atBottom || !moved) idle++;
      else idle = 0;

      /* "Nhích" lên rồi xuống lại để đánh thức lazy-load của trang */
      if (atBottom && !grew && idle >= 1 && target.isConnected) {
        target.scrollTop = Math.max(0, maxTopOf(target) - 160);
        await sleep(60);
        target.scrollTop = maxTopOf(target);
        try {
          target.dispatchEvent(new Event('scroll'));
        } catch (e) {
          /* bỏ qua */
        }
      }

      if (idle >= idleNeeded) break;
    }

    if (cfg.restoreScroll !== false) {
      try {
        target.scrollTop = originalTop;
      } catch (e) {
        /* bỏ qua */
      }
      percent = 0;
    }
    if (onScrollInfo) onScrollInfo({ percent, steps, atBottom: true });
    return { scrolled: true, steps, percent };
  }

  /**
   * Chạy chọn hàng loạt.
   * action: 'select' | 'clear' | 'invert' | 'select-scroll' | 'select-scroll-bottom'
   */
  async function run(action, opts) {
    if (busy) return { ok: false, busy: true };
    busy = true;

    const cfg = { ...settings, ...(opts || {}) };

    /* "Chọn + cuộn đến cuối trang": cuộn tới đáy, không kéo về vị trí cũ */
    if (action === 'select-scroll-bottom') {
      action = 'select';
      cfg.autoScroll = true;
      cfg.restoreScroll = false;
      cfg.idleRounds = Math.max(Number(cfg.idleRounds) || 4, 6);
    }
    if (action === 'select-scroll') {
      action = 'select';
      cfg.autoScroll = true;
    }
    if (cfg.toBottom) {
      cfg.autoScroll = true;
      cfg.restoreScroll = false;
      cfg.idleRounds = Math.max(Number(cfg.idleRounds) || 4, 6);
    }

    const deadline = Date.now() + (Number(cfg.maxDuration) || 120000);
    const seen = new Set();
    const started = Date.now();
    let clicked = 0;
    let headerUsed = false;
    let lastTotal = 0;
    let lastChecked = 0;
    let scrollPercent = 0;

    publish({ phase: 'start', action });

    try {
      if (action === 'select' && cfg.preferHeaderSelectAll) {
        headerUsed = await tryHeaderSelectAll(cfg);
        if (headerUsed) {
          const boxes = detectCheckboxes();
          lastTotal = boxes.length;
          lastChecked = boxes.filter(isChecked).length;
          publish({
            phase: 'progress',
            action,
            clicked: 1,
            total: lastTotal,
            checked: lastChecked,
            headerUsed: true
          });
        }
      } else if (action === 'clear' && cfg.preferHeaderSelectAll) {
        headerUsed = await tryHeaderClear(cfg);
      }

      const clickPass = async () => {
        const boxes = detectCheckboxes();
        const header = findSelectAllBox(boxes);

        for (const box of boxes) {
          if (Date.now() > deadline) break;
          if (box === header) continue;
          if (seen.has(box)) continue;
          seen.add(box);

          const want = action === 'clear' ? false : action === 'invert' ? !isChecked(box) : true;
          if (isChecked(box) === want) continue;
          if (setChecked(box, want)) clicked++;
          if (Number(cfg.clickDelay) > 0) await sleep(Number(cfg.clickDelay));
        }

        const fresh = detectCheckboxes();
        lastTotal = fresh.length;
        lastChecked = fresh.filter(isChecked).length;
        publish({
          phase: 'progress',
          action,
          clicked,
          total: lastTotal,
          checked: lastChecked,
          scrollPercent
        });
      };

      await clickPass();

      if (cfg.autoScroll) {
        await autoScrollLoop(clickPass, deadline, cfg, (info) => {
          scrollPercent = info.percent;
          /* Cập nhật tiến độ cuộn lên panel mà không phải quét lại DOM */
          publish({
            phase: 'scroll',
            action,
            clicked,
            total: lastTotal,
            checked: lastChecked,
            scrollPercent: info.percent,
            steps: info.steps,
            atBottom: info.atBottom
          });
        });
      }

      const boxes = detectCheckboxes();
      const result = {
        phase: 'done',
        action,
        clicked,
        total: boxes.length,
        checked: boxes.filter(isChecked).length,
        headerUsed,
        scrollPercent: cfg.restoreScroll === false ? 100 : 0,
        ms: Date.now() - started
      };
      publish(result);
      return { ok: true, ...result };
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      publish({ phase: 'error', action, error: message });
      return { ok: false, error: message };
    } finally {
      busy = false;
    }
  }

  /* ------------------------------------------------------------
   * UI panel nổi (chỉ tồn tại ở frame top)
   * ---------------------------------------------------------- */
  const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.bsa-wrap {
  position: absolute; right: 18px; bottom: 18px;
  width: 274px; pointer-events: auto;
  background: #0f1a24; color: #e8eef5;
  border: 1px solid #24425a; border-radius: 12px;
  box-shadow: 0 16px 38px rgba(0,0,0,.45);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  overflow: hidden;
  user-select: none;
}
.bsa-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 10px; cursor: move;
  background: linear-gradient(180deg, #16283a, #12202e);
  border-bottom: 1px solid #1e3446;
}
.bsa-dot { width: 9px; height: 9px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.16); flex: none; }
.bsa-wrap.running .bsa-dot { animation: bsa-pulse 1s infinite; }
@keyframes bsa-pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .45; transform: scale(.75); } }
.bsa-title { font-weight: 600; font-size: 13px; letter-spacing: .1px; flex: 1; white-space: nowrap; }
.bsa-count { font-size: 11px; color: #7dd3fc; background: rgba(56,189,248,.12); padding: 1px 7px; border-radius: 999px; }
.bsa-count:empty { display: none; }
.bsa-icon {
  all: unset; cursor: pointer; width: 20px; height: 20px; line-height: 18px;
  text-align: center; border-radius: 5px; color: #9fb3c8; font-size: 15px;
}
.bsa-icon:hover { background: #1e3446; color: #fff; }
.bsa-body { padding: 10px; display: grid; gap: 8px; }
.bsa-wrap.collapsed { width: 210px; }
.bsa-wrap.collapsed .bsa-body { display: none; }
.bsa-status { font-size: 12px; color: #9fb3c8; min-height: 34px; padding: 7px 8px; background: #0b1620; border: 1px solid #1a2c3c; border-radius: 8px; overflow-wrap: anywhere; }
.bsa-status.ok { color: #86efac; border-color: #14532d; background: #08210f; }
.bsa-status.warn { color: #fcd34d; border-color: #4a3a10; background: #241c05; }
.bsa-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.bsa-btn {
  all: unset; cursor: pointer; text-align: center; padding: 8px 6px;
  border-radius: 8px; background: #17293a; color: #dbe7f1;
  border: 1px solid #24425a; font-size: 12px; font-weight: 600;
  transition: background .12s, transform .06s;
}
.bsa-btn:hover { background: #1e3448; border-color: #2f5877; }
.bsa-btn:active { transform: translateY(1px); }
.bsa-btn.primary { background: linear-gradient(180deg, #16a34a, #12813c); border-color: #1cb155; color: #fff; }
.bsa-btn.primary:hover { background: linear-gradient(180deg, #17b552, #13893f); }
.bsa-btn[disabled] { opacity: .5; pointer-events: none; }
.bsa-btn.wide { grid-column: 1 / -1; }
.bsa-toggle { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #b9c9d8; cursor: pointer; padding: 2px; }
.bsa-toggle input { accent-color: #22c55e; width: 14px; height: 14px; margin: 0; cursor: pointer; }
.bsa-hint { font-size: 11px; color: #6f8397; text-align: center; }
.bsa-hint kbd { background: #17293a; border: 1px solid #24425a; border-radius: 4px; padding: 0 4px; font-family: inherit; font-size: 10px; color: #b9c9d8; }
.bsa-toast {
  position: absolute; left: 50%; bottom: 24px; transform: translate(-50%, 14px);
  background: #0f1a24; color: #e8eef5; border: 1px solid #24425a;
  padding: 9px 14px; border-radius: 10px; font: 600 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  box-shadow: 0 10px 26px rgba(0,0,0,.5); opacity: 0; pointer-events: none;
  transition: opacity .18s, transform .18s; max-width: 320px; text-align: center;
}
.bsa-toast.show { opacity: 1; transform: translate(-50%, 0); }
`;

  let hostEl = null;
  let shadow = null;
  let wrapEl = null;
  let statusEl = null;
  let countEl = null;
  let toastEl = null;
  let autoEl = null;
  const frameStats = new Map();
  let summaryTimer = null;
  let currentAction = 'select';
  let uiBusy = false;

  function verb(action) {
    if (action === 'clear') return 'Unselecting';
    if (action === 'invert') return 'Inverting';
    return 'Selecting';
  }

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'bsa-status' + (kind ? ' ' + kind : '');
  }

  function setRunning(on) {
    uiBusy = !!on;
    if (!wrapEl) return;
    wrapEl.classList.toggle('running', !!on);
    wrapEl.querySelectorAll('.bsa-btn').forEach((b) => {
      if (on) b.setAttribute('disabled', '');
      else b.removeAttribute('disabled');
    });
  }

  function showToast(text) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove('show'), 3800);
  }

  function sumStats() {
    let checked = 0;
    let clicked = 0;
    let total = 0;
    frameStats.forEach((s) => {
      checked += Number(s.checked) || 0;
      clicked += Number(s.clicked) || 0;
      total += Number(s.total) || 0;
    });
    return { checked, clicked, total };
  }

  function setCollapsed(collapsed) {
    if (!wrapEl) return;
    wrapEl.classList.toggle('collapsed', !!collapsed);
    saveSettings({ panelCollapsed: !!collapsed });
  }

  function applySavedPos() {
    const pos = settings.panelPos;
    if (!wrapEl || !pos) return;
    const x = Math.max(0, Math.min(Number(pos.left) || 0, window.innerWidth - 60));
    const y = Math.max(0, Math.min(Number(pos.top) || 0, window.innerHeight - 40));
    wrapEl.style.left = x + 'px';
    wrapEl.style.top = y + 'px';
    wrapEl.style.right = 'auto';
    wrapEl.style.bottom = 'auto';
  }

  function mountUI(open) {
    if (!IS_TOP) return;
    if (hostEl) {
      if (open) setCollapsed(false);
      return;
    }

    hostEl = document.createElement('div');
    hostEl.id = 'bsa-host';
    hostEl.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    (document.documentElement || document.body).appendChild(hostEl);

    shadow = hostEl.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;

    wrapEl = document.createElement('div');
    wrapEl.className = 'bsa-wrap' + (settings.panelCollapsed ? ' collapsed' : '');
    wrapEl.innerHTML =
      '<div class="bsa-bar">' +
      '  <span class="bsa-dot"></span>' +
      '  <span class="bsa-title">Bulk Select All</span>' +
      '  <span class="bsa-count"></span>' +
      '  <button class="bsa-icon" id="bsa-min" title="Collapse / expand">–</button>' +
      '</div>' +
      '<div class="bsa-body">' +
      '  <div class="bsa-status">Ready — click “Select + scroll to bottom”</div>' +
      '  <div class="bsa-btns">' +
      '    <button class="bsa-btn primary wide" data-act="select-scroll-bottom" data-scroll="1" data-bottom="1">Select + scroll to bottom</button>' +
      '    <button class="bsa-btn" data-act="select" data-scroll="1">Select all</button>' +
      '    <button class="bsa-btn" data-act="select" data-scroll="0">Select visible</button>' +
      '    <button class="bsa-btn" data-act="invert" data-scroll="1">Invert</button>' +
      '    <button class="bsa-btn" data-act="clear" data-scroll="0">Unselect all</button>' +
      '  </div>' +
      '  <label class="bsa-toggle"><input type="checkbox" id="bsa-auto"><span>Auto-select on page load</span></label>' +
      '  <div class="bsa-hint">Shortcut <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd></div>' +
      '</div>';

    toastEl = document.createElement('div');
    toastEl.className = 'bsa-toast';

    shadow.appendChild(style);
    shadow.appendChild(wrapEl);
    shadow.appendChild(toastEl);

    statusEl = shadow.querySelector('.bsa-status');
    countEl = shadow.querySelector('.bsa-count');
    autoEl = shadow.querySelector('#bsa-auto');
    autoEl.checked = (settings.autoRunHosts || []).includes(location.hostname);

    applySavedPos();
    if (settings.panelCollapsed && open) wrapEl.classList.remove('collapsed');

    /* --- Sự kiện click trong panel --- */
    wrapEl.addEventListener('click', (ev) => {
      const target = ev.target;
      if (!target || !target.closest) return;
      if (target.closest('#bsa-min')) {
        setCollapsed(!wrapEl.classList.contains('collapsed'));
        return;
      }
      const btn = target.closest('.bsa-btn');
      if (!btn) return;
      if (uiBusy) {
        showToast('Still running — hang on…');
        return;
      }
      const action = btn.getAttribute('data-act') || 'select';
      const scroll = btn.getAttribute('data-scroll') === '1';
      const bottom = btn.getAttribute('data-bottom') === '1';
      currentAction = action === 'select-scroll' || action === 'select-scroll-bottom' ? 'select' : action;
      broadcast(action, { autoScroll: scroll, toBottom: bottom });
    });

    autoEl.addEventListener('change', () => {
      const hosts = new Set(settings.autoRunHosts || []);
      if (autoEl.checked) hosts.add(location.hostname);
      else hosts.delete(location.hostname);
      saveSettings({ autoRunHosts: Array.from(hosts) });
      showToast(autoEl.checked ? 'Will auto-select when this page opens' : 'Auto-select disabled for this page');
    });

    /* --- Kéo panel --- */
    const bar = shadow.querySelector('.bsa-bar');
    let dragState = null;
    bar.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      if (ev.target && ev.target.closest && ev.target.closest('#bsa-min')) return;
      const rect = wrapEl.getBoundingClientRect();
      dragState = { dx: ev.clientX - rect.left, dy: ev.clientY - rect.top };
      try {
        bar.setPointerCapture(ev.pointerId);
      } catch (e) {
        /* bỏ qua */
      }
      ev.preventDefault();
    });
    bar.addEventListener('pointermove', (ev) => {
      if (!dragState) return;
      const w = wrapEl.offsetWidth;
      const h = wrapEl.offsetHeight;
      const x = Math.max(0, Math.min(ev.clientX - dragState.dx, window.innerWidth - w));
      const y = Math.max(0, Math.min(ev.clientY - dragState.dy, window.innerHeight - h));
      wrapEl.style.left = x + 'px';
      wrapEl.style.top = y + 'px';
      wrapEl.style.right = 'auto';
      wrapEl.style.bottom = 'auto';
    });
    const endDrag = () => {
      if (!dragState) return;
      dragState = null;
      saveSettings({ panelPos: { left: wrapEl.offsetLeft, top: wrapEl.offsetTop } });
    };
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);
  }

  function broadcast(action, options) {
    setRunning(true);
    frameStats.clear();
    setStatus(verb(action) + '…');
    try {
      chrome.runtime.sendMessage(
        { source: 'BSA', type: 'BROADCAST', action: action, options: options || {} },
        () => {
          void chrome.runtime.lastError;
        }
      );
    } catch (e) {
      setRunning(false);
      setStatus('Could not send the command to this page.', 'warn');
      return;
    }
    setTimeout(() => {
      if (!frameStats.size) {
        setRunning(false);
        setStatus('No checkboxes found on this page.', 'warn');
      }
    }, 2500);
  }

  function handleStateMessage(msg) {
    if (!msg || msg.kind !== 'state') return;
    if (msg.phase === 'start') {
      frameStats.clear();
      currentAction = msg.action || currentAction;
      setRunning(true);
    }
    frameStats.set(msg.frameId || 'unknown', msg);

    const totals = sumStats();
    if (countEl) countEl.textContent = totals.checked ? String(totals.checked) : '';

    if (msg.phase === 'start' || msg.phase === 'progress') {
      setStatus(verb(currentAction) + '… ' + totals.checked + ' selected (' + totals.clicked + ' clicks)');
    } else if (msg.phase === 'scroll') {
      setStatus(
        verb(currentAction) + '… ' + totals.checked + ' selected · scrolled ' +
          (Number(msg.scrollPercent) || 0) + '%' + (msg.atBottom ? ' (bottom)' : '')
      );
    } else if (msg.phase === 'error') {
      setStatus('Error: ' + (msg.error || 'unknown'), 'warn');
    }

    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(finishRun, msg.phase === 'done' || msg.phase === 'error' ? 600 : 5000);
  }

  function finishRun() {
    clearTimeout(summaryTimer);
    setRunning(false);
    if (!frameStats.size) return;

    const totals = sumStats();
    const action = currentAction;
    let headerUsed = false;
    let scrolledToEnd = false;
    frameStats.forEach((s) => {
      if (s.headerUsed) headerUsed = true;
      if (s.phase === 'done' && Number(s.scrollPercent) === 100) scrolledToEnd = true;
    });

    if (totals.total === 0 && totals.clicked === 0) {
      setStatus('No checkboxes found on this page.', 'warn');
      showToast('No checkboxes found');
      return;
    }

    let text;
    if (action === 'clear') {
      text = 'Unselected ' + totals.clicked + ' item' + (totals.clicked === 1 ? '' : 's') + '.';
    } else if (action === 'invert') {
      text = 'Inverted ' + totals.clicked + ' item' + (totals.clicked === 1 ? '' : 's') + '.';
    } else {
      text =
        'Selected ' + totals.checked + '/' + totals.total + ' item' + (totals.total === 1 ? '' : 's') +
        (headerUsed
          ? ' (via the page’s “select all” box)'
          : ' (' + totals.clicked + ' click' + (totals.clicked === 1 ? '' : 's') + ')') +
        (scrolledToEnd ? ' · scrolled to the bottom.' : '.');
    }
    setStatus(text, 'ok');
    showToast(text);
    if (countEl) countEl.textContent = totals.checked ? String(totals.checked) : '';
  }

  function syncPanelSettings() {
    if (!wrapEl) return;
    if (autoEl) autoEl.checked = (settings.autoRunHosts || []).includes(location.hostname);
    if (statusEl && !statusEl.textContent) setStatus('Ready — click “Select + scroll to bottom”');
  }

  /* ------------------------------------------------------------
   * Nhận lệnh + tự động chạy khi mở trang
   * ---------------------------------------------------------- */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.source !== 'BSA') return;

    if (msg.type === 'RUN') {
      if (busy) {
        sendResponse({ ok: false, busy: true });
        return;
      }
      run(msg.action || 'select', msg.options || {})
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    if (msg.type === 'PING') {
      let boxes = 0;
      try {
        boxes = detectCheckboxes().length;
      } catch (e) {
        /* bỏ qua */
      }
      sendResponse({ ok: true, boxes: boxes, top: IS_TOP, busy: busy });
      return;
    }

    if (msg.type === 'SHOW_PANEL') {
      if (IS_TOP) {
        mountUI(true);
        syncPanelSettings();
      }
      sendResponse({ ok: true });
      return;
    }
  });

  window.addEventListener(
    'message',
    (ev) => {
      const data = ev.data;
      if (!IS_TOP || !data || data.source !== 'BSA' || data.kind !== 'state') return;
      handleStateMessage(data);
    },
    false
  );

  function scheduleAutoRun() {
    if (autoRunStarted) return;
    autoRunStarted = true;
    const startedAt = Date.now();

    const tick = () => {
      if (busy) {
        autoRunTimer = setTimeout(tick, 800);
        return;
      }
      let found = 0;
      try {
        found = detectCheckboxes().length;
      } catch (e) {
        found = 0;
      }
      if (found > 0 && document.readyState !== 'loading') {
        autoRunTimer = setTimeout(() => {
          if (!busy) run('select', { autoScroll: settings.autoScroll !== false });
        }, Number(settings.autoRunDelay) || 800);
        return;
      }
      if (Date.now() - startedAt > (Number(settings.autoRunWait) || 15000)) return;
      autoRunTimer = setTimeout(tick, 700);
    };

    autoRunTimer = setTimeout(tick, 600);
  }

  (async function init() {
    await loadSettings();

    if (IS_TOP) {
      mountUI(false);
      syncPanelSettings();
    }

    const hosts = hostList();
    const autoHosts = Array.isArray(settings.autoRunHosts) ? settings.autoRunHosts : [];
    if (autoHosts.some((h) => hosts.indexOf(h) !== -1)) scheduleAutoRun();
  })();
})();

