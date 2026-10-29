/* match.js — 首頁「上傳截圖比對」：最上方一顆按鈕，選圖（或 Ctrl+V 貼上、拖放）後跳出比對結果。
 *
 * 比對完全在你的瀏覽器裡進行（Web Worker 跑 matchcore.js），截圖不會上傳到任何地方。
 * 比對對象 = 網站目前列出的那些股票（match_index.json / match_index.bin，每次排程上傳時一起更新），
 * 所以不管你什麼時候上傳截圖，比的都是網站上目前已發布的最新資料。
 *
 * 結果視窗直接「複製首頁上那張卡片」，所屬產業、權證/期貨有無、量、保證金、K線圖都和首頁一致。
 */
(function () {
  'use strict';
  if (window.__matchUiLoaded) return;
  window.__matchUiLoaded = true;

  // ---------------------------------------------------------------- 基本設定
  var cur = document.currentScript;
  if (!cur) {
    var ss = document.getElementsByTagName('script');
    for (var i = ss.length - 1; i >= 0; i--) if (/match\.js(\?|$)/.test(ss[i].src)) { cur = ss[i]; break; }
  }
  var BASE = cur && cur.src ? new URL('.', cur.src).href : new URL('./', location.href).href;
  var MAX_SIDE = 1400;                         // 太大的截圖先縮小再解析（手機/4K 螢幕；也限制手機的記憶體用量）
  var DB_PRICE_Y = [[51, 443], [471, 600], [629, 758]];   // 網站圖三個面板內部的 y 範圍（1210x825 原圖）
  var AX_L = 84.7, AX_W = 1089.0;

  // ---------------------------------------------------------------- 樣式
  var css = [
    '#mm-bar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:0 0 14px}',
    '#mm-btn{background:#2962FF;border:1px solid #2962FF;color:#fff;font-weight:bold;border-radius:6px;padding:9px 16px;font-size:14px;cursor:pointer;font-family:inherit}',
    '#mm-btn:hover{filter:brightness(1.12)}',
    '#mm-hint{color:#8d93a3;font-size:12px}',
    '#mm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9999;display:none;align-items:flex-start;justify-content:center;overflow:auto;padding:14px}',
    '#mm-overlay.open{display:flex}',
    '#mm-dialog{position:relative;background:#12141A;border:1px solid #3A3E4D;border-radius:12px;width:100%;max-width:1000px;padding:16px 18px 20px;margin:auto 0;color:#D1D4DC;font-family:"Microsoft JhengHei",-apple-system,sans-serif}',
    '#mm-close{position:absolute;right:10px;top:8px;background:none;border:0;color:#9aa0b0;font-size:22px;cursor:pointer;line-height:1;padding:4px 8px}',
    '#mm-close:hover{color:#fff}',
    '.mm-top{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding-right:34px}',
    '.mm-badge{border-radius:6px;padding:4px 10px;font-weight:bold;font-size:14px}',
    '.mm-badge.sure{background:#2962FF;color:#fff}.mm-badge.maybe{background:#F9A825;color:#222}.mm-badge.none{background:#3A3E4D;color:#D1D4DC}',
    '.mm-sim{font-size:14px;color:#90CAF9}',
    '.mm-sub{width:100%;font-size:12.5px;color:#9aa0b0;margin-top:2px}',
    '.mm-warn{margin:10px 0 0;padding:8px 10px;border-radius:6px;background:#2a2417;border:1px solid #5a4a1e;color:#FFCA28;font-size:12.5px;line-height:1.6}',
    '.mm-err{margin:10px 0 0;padding:10px 12px;border-radius:6px;background:#2a1a1c;border:1px solid #6b2b30;color:#ff8a80;font-size:13px;line-height:1.7}',
    '#mm-cardwrap{margin:14px 0 10px}',
    '#mm-dialog .card{margin:0;border-color:#4a4f60}',
    '#mm-dialog .card-head{font-size:15px;padding:12px 16px;gap:12px}',
    '#mm-dialog .card-head .tag{font-size:14px;padding:2px 8px}',
    '.mm-actions{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0}',
    '.mm-actions button,.mm-chip{background:#1E222D;color:#D1D4DC;border:1px solid #3A3E4D;border-radius:6px;padding:7px 12px;font-size:13px;cursor:pointer;font-family:inherit}',
    '.mm-actions button:hover,.mm-chip:hover{border-color:#2962FF}',
    '.mm-chip.on{background:#2962FF;border-color:#2962FF;color:#fff}',
    '.mm-others{margin-top:10px;font-size:12.5px;color:#9aa0b0}',
    '.mm-others .mm-chip{margin:4px 6px 0 0}',
    '#mm-verify{display:none;margin-top:10px;gap:10px;flex-wrap:wrap}',
    '#mm-verify.open{display:flex}',
    '#mm-verify .vbox{flex:1 1 360px;min-width:0}',
    '#mm-verify .vcap{font-size:12px;color:#9aa0b0;margin:0 0 4px}',
    '#mm-verify canvas{width:100%;height:auto;border:1px solid #3A3E4D;border-radius:6px;background:#12141A;display:block}',
    '.mm-loading{padding:40px 10px;text-align:center;color:#90CAF9;font-size:15px}',
    '.mm-spin{width:34px;height:34px;border:4px solid #2a3042;border-top-color:#2962FF;border-radius:50%;margin:0 auto 14px;animation:mmspin .9s linear infinite}',
    '@keyframes mmspin{to{transform:rotate(360deg)}}',
    '.mm-flash{animation:mmflash 2.6s ease-out 1}',
    '@keyframes mmflash{0%,60%{outline:3px solid #FFCA28;outline-offset:3px}100%{outline:3px solid transparent;outline-offset:3px}}',
    '#mm-drop{position:fixed;inset:0;background:rgba(41,98,255,.18);border:3px dashed #2962FF;z-index:9998;display:none;align-items:center;justify-content:center;color:#fff;font-size:22px;pointer-events:none}',
    '#mm-drop.on{display:flex}'
  ].join('\n');
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  // ---------------------------------------------------------------- DOM
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  var bar = el('div'); bar.id = 'mm-bar';
  var btn = el('button', '', '📷 上傳截圖比對'); btn.id = 'mm-btn'; btn.type = 'button';
  var hint = el('span', '', '選一張看盤截圖（或直接 Ctrl+V 貼上／拖進來），找出它是下面清單中的哪一檔。截圖只在你的瀏覽器處理，不會上傳。');
  hint.id = 'mm-hint';
  bar.appendChild(btn); bar.appendChild(hint);
  var h1 = document.querySelector('h1');
  if (h1 && h1.parentNode) h1.parentNode.insertBefore(bar, h1.nextSibling);
  else document.body.insertBefore(bar, document.body.firstChild);

  var fileInput = el('input'); fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  var overlay = el('div'); overlay.id = 'mm-overlay';
  var dialog = el('div'); dialog.id = 'mm-dialog'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  var closeBtn = el('button', '', '✕'); closeBtn.id = 'mm-close'; closeBtn.type = 'button'; closeBtn.setAttribute('aria-label', '關閉');
  var body = el('div'); body.id = 'mm-body';
  dialog.appendChild(closeBtn); dialog.appendChild(body);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  var dropHint = el('div', '', '放開滑鼠，開始比對這張截圖'); dropHint.id = 'mm-drop';
  document.body.appendChild(dropHint);

  function openModal() { overlay.classList.add('open'); document.body.style.overflow = 'hidden'; }
  function closeModal() { overlay.classList.remove('open'); document.body.style.overflow = ''; }
  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  // ---------------------------------------------------------------- 引擎（Web Worker；失敗退回主執行緒）
  var worker = null, workerFailed = false, seq = 0, pending = {}, mainCore = null;

  function ensureWorker() {
    if (worker || workerFailed) return;
    try {
      worker = new Worker(BASE + 'matchworker.js');
      worker.onmessage = function (ev) {
        var m = ev.data, p = pending[m.id];
        if (!p) return;
        delete pending[m.id];
        if (m.ok) p.resolve(m); else p.reject(new Error(m.error));
      };
      worker.onerror = function (ev) {
        workerFailed = true; worker = null;
        Object.keys(pending).forEach(function (k) { pending[k].reject(new Error('Worker 發生錯誤，改用主執行緒重試')); delete pending[k]; });
      };
    } catch (e) { workerFailed = true; worker = null; }
  }
  function callWorker(msg, transfer) {
    return new Promise(function (resolve, reject) {
      var id = ++seq; msg.id = id; pending[id] = { resolve: resolve, reject: reject };
      worker.postMessage(msg, transfer || []);
    });
  }
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function () { rej(new Error('載入 ' + src + ' 失敗')); };
      document.head.appendChild(s);
    });
  }
  var mainDb = null;
  async function runInMain(img) {
    if (!window.MatchCore) await loadScript(BASE + 'matchcore.js');
    if (!mainDb) mainDb = await window.MatchCore.loadIndex(BASE);
    var res = window.MatchCore.runMatch(new Uint8ClampedArray(img.imageData.data), img.w, img.h, mainDb, { maxOff: 60, minOff: -5, prune: true });
    res.scan = mainDb.scan; res.built = mainDb.built;
    if (res.ok) res.results.forEach(function (r) { r.meta = mainDb.meta[r.s]; r.n = mainDb.n[r.s]; });
    return res;
  }
  async function runMatch(img) {
    ensureWorker();
    if (worker) {
      try {
        var buf = new Uint8ClampedArray(img.imageData.data).buffer;        // 複製一份再轉移，保留原圖給驗證圖用
        var m = await callWorker({ type: 'match', buffer: buf, w: img.w, h: img.h, maxOff: 60, minOff: -5 }, [buf]);
        return m.result;
      } catch (e) {
        if (!workerFailed) throw e;
      }
    }
    return runInMain(img);
  }
  function preload() { ensureWorker(); if (worker) callWorker({ type: 'init' }).catch(function () {}); }

  // ---------------------------------------------------------------- 讀圖
  function decodeViaImg(file) {                  // 舊瀏覽器沒有 createImageBitmap 時的備援
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), im = new Image();
      im.onload = function () { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = function () { URL.revokeObjectURL(url); reject(new Error('這個檔案不是瀏覽器讀得懂的圖片')); };
      im.src = url;
    });
  }
  async function readImage(file) {
    var bmp;
    if (typeof createImageBitmap === 'function') {
      try { bmp = await createImageBitmap(file, { colorSpaceConversion: 'none' }); }
      catch (e) {
        try { bmp = await createImageBitmap(file); } catch (e2) { bmp = await decodeViaImg(file); }
      }
    } else bmp = await decodeViaImg(file);
    var w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight, s = 1;
    if (Math.max(w, h) > MAX_SIDE) { s = MAX_SIDE / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var cx = cv.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
    cx.drawImage(bmp, 0, 0, w, h);
    return { canvas: cv, imageData: cx.getImageData(0, 0, w, h), w: w, h: h, scale: s };
  }

  // ---------------------------------------------------------------- 結果卡片（複製首頁卡片）
  function pageCardFor(meta) {
    var imgs = document.querySelectorAll('.panel .card img');
    for (var i = 0; i < imgs.length; i++) {
      var src = imgs[i].getAttribute('src');
      if (src === meta.img) return imgs[i].closest('.card');
    }
    return null;
  }
  function buildCardFromMeta(meta) {
    var card = el('div', 'card'), head = el('div', 'card-head');
    head.appendChild(el('span', 'sym', meta.code));
    head.appendChild(el('span', 'name', meta.name));
    head.appendChild(el('span', 'price', '收盤 ' + meta.price));
    head.appendChild(el('span', 'level', '位階 ' + meta.level));
    (meta.tags || []).forEach(function (t) { head.appendChild(el('span', 'tag', t)); });
    card.appendChild(head);
    var im = el('img'); im.src = meta.img; card.appendChild(im);
    return card;
  }
  function cardFor(meta) {
    var src = pageCardFor(meta), c;
    if (src) {
      c = src.cloneNode(true);
      c.classList.remove('hidden');
      c.removeAttribute('id');
    } else c = buildCardFromMeta(meta);
    var im = c.querySelector('img');
    if (im) im.removeAttribute('loading');
    return c;
  }

  // ---------------------------------------------------------------- 驗證圖
  function drawFit(canvas, img, res, fit) {
    var q = res.q, K = q.K, pitch = q.pitch;
    var maxW = 560, s = Math.min(3, Math.max(1, maxW / img.w));
    canvas.width = Math.round(img.w * s); canvas.height = Math.round(img.h * s);
    var cx = canvas.getContext('2d');
    cx.drawImage(img.canvas, 0, 0, canvas.width, canvas.height);
    var hw = Math.max(5, 0.36 * pitch * s);
    function line(x, y, col) { cx.strokeStyle = col; cx.lineWidth = 2; cx.beginPath(); cx.moveTo(x - hw, y); cx.lineTo(x + hw, y); cx.stroke(); }
    function circ(x, y, col) { cx.strokeStyle = col; cx.lineWidth = 2; cx.beginPath(); cx.arc(x, y, Math.max(4, hw * 0.55), 0, 6.2832); cx.stroke(); }
    var cols = ['#ffffff', '#ffffff', '#ffd700', '#ffd700', '#00ffff', '#00ff00'];
    for (var t = 0; t < K; t++) {
      var x = q.xc[K - 1 - t] * s;
      for (var f = 0; f < 6; f++) {
        var y = fit.predP[t * 6 + f];
        if (!isFinite(y)) continue;
        if (f >= 4) circ(x, y * s, cols[f]); else line(x, y * s, cols[f]);
      }
      if (isFinite(q.zero)) {
        var z = q.zero;
        var hv = fit.predM[t * 3];
        if (isFinite(hv)) { cx.strokeStyle = '#ffffff'; cx.lineWidth = 3; cx.beginPath(); cx.moveTo(x + hw * 1.1, z * s); cx.lineTo(x + hw * 1.1, (z - hv) * s); cx.stroke(); }
        var dv = fit.predM[t * 3 + 1], ev = fit.predM[t * 3 + 2];
        if (isFinite(dv)) circ(x, (z - dv) * s, '#ff9600');
        if (isFinite(ev)) circ(x, (z - ev) * s, '#00c8ff');
      }
    }
  }
  function drawDbChart(canvas, imgEl, r) {
    var n = r.n, off = r.off, K = r.kEff;
    var maxW = 700, s = Math.min(1, maxW / imgEl.naturalWidth);
    canvas.width = Math.round(imgEl.naturalWidth * s); canvas.height = Math.round(imgEl.naturalHeight * s);
    var cx = canvas.getContext('2d');
    cx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
    var iLast = n - 1 - Math.max(off, 0), iFirst = iLast - K + 1;
    function xc(i) { return AX_L + (i + 1) * AX_W / (n + 1); }
    var x0 = (xc(Math.max(iFirst, 0)) - 4.5) * s, x1 = (xc(Math.min(iLast, n - 1)) + 4.5) * s;
    cx.strokeStyle = '#FFEB3B'; cx.lineWidth = 2;
    DB_PRICE_Y.forEach(function (p) { cx.strokeRect(x0, p[0] * s, x1 - x0, (p[1] - p[0]) * s); });
  }

  // ---------------------------------------------------------------- 結果畫面
  var VERDICT = { sure: '高度吻合', maybe: '可能是這檔，請核對', none: '找不到可信的比對' };
  function offText(off, scan) {
    var day = (scan || '').slice(0, 10);
    if (off === 0) return '截圖最後一根 K 棒 ＝ 網站最新一天（網站掃描日 ' + day + '）';
    if (off < 0) return '截圖比網站資料新 ' + (-off) + ' 根K棒：網站資料掃描於 ' + scan + '，還沒有最新的 ' + (-off) + ' 根，比對時已略過那 ' + (-off) + ' 根';
    return '截圖最後一根 K 棒 ＝ 網站最新一天往前 ' + off + ' 根（約 ' + off + ' 個交易日前）';
  }
  function pageScan() {
    var m = document.querySelector('.meta');
    var t = m ? m.textContent.match(/掃描時間：\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/) : null;
    return t ? t[1] : null;
  }

  var state = null;       // {img, res, sel}

  function renderResult(img, res) {
    state = { img: img, res: res, sel: 0 };
    body.innerHTML = '';
    if (!res.ok) {
      var e = el('div', 'mm-err');
      e.innerHTML = '<b>這張截圖沒辦法比對</b><br>' + (res.notes || ['解析不到K棒']).join('；') +
        '<br>請確認截圖裡看得到 K 棒（紅/綠）；有持股線、多空線、MACD 會更準。';
      body.appendChild(e);
      return;
    }
    var top = el('div', 'mm-top');
    var badge = el('span', 'mm-badge ' + res.verdict, VERDICT[res.verdict]); badge.id = 'mm-badge';
    var sim = el('span', 'mm-sim'); sim.id = 'mm-sim';
    var sub = el('div', 'mm-sub'); sub.id = 'mm-sub';
    top.appendChild(badge); top.appendChild(sim); top.appendChild(sub);
    body.appendChild(top);

    var notes = (res.warnings || []).slice();
    var ps = pageScan();
    if (ps && res.scan && ps !== res.scan) notes.push('比對資料庫的掃描時間（' + res.scan + '）和目前頁面清單（' + ps + '）不是同一次，結果可能不準；請重新整理頁面。');
    if (notes.length) { var w = el('div', 'mm-warn'); w.innerHTML = notes.map(function (n) { return '⚠ ' + n; }).join('<br>'); body.appendChild(w); }

    var wrap = el('div'); wrap.id = 'mm-cardwrap'; body.appendChild(wrap);
    var acts = el('div', 'mm-actions');
    var bLoc = el('button', '', '📍 在下方清單中找到這檔'); bLoc.type = 'button'; bLoc.id = 'mm-locate';
    var bVer = el('button', '', '🔍 查看比對驗證圖'); bVer.type = 'button'; bVer.id = 'mm-verifybtn';
    acts.appendChild(bLoc); acts.appendChild(bVer); body.appendChild(acts);
    var ver = el('div'); ver.id = 'mm-verify';
    ver.innerHTML = '<div class="vbox"><p class="vcap">你的截圖（彩色記號＝資料庫那檔依擬合結果疊上去的位置：白線＝最高/最低、黃線＝實體上下緣、青圈＝持股線、綠圈＝多空線、橘/藍圈＝DIF/DEA、白色短線＝MACD 柱）</p><canvas id="mm-cv1"></canvas></div>' +
      '<div class="vbox"><p class="vcap">網站上的圖（黃框＝被比對到的區段）</p><canvas id="mm-cv2"></canvas></div>';
    body.appendChild(ver);
    var others = el('div', 'mm-others'); others.id = 'mm-others'; body.appendChild(others);

    bLoc.addEventListener('click', function () { locate(res.results[state.sel].meta); });
    bVer.addEventListener('click', function () { ver.classList.toggle('open'); if (ver.classList.contains('open')) drawVerify(); });
    showCandidate(0);
  }

  function showCandidate(i) {
    var res = state.res, r = res.results[i];
    state.sel = i;
    document.getElementById('mm-sim').textContent = '相符度 ' + r.sim.toFixed(0) + '%' + (i === 0 ? '' : '　（候選 #' + r.rank + '）');
    document.getElementById('mm-sub').textContent = offText(r.off, res.scan) + '　·　截圖解析出 ' + res.K + ' 根K棒';
    var badge = document.getElementById('mm-badge');
    if (i === 0) { badge.className = 'mm-badge ' + res.verdict; badge.textContent = VERDICT[res.verdict]; }
    else { badge.className = 'mm-badge none'; badge.textContent = '候選 #' + r.rank; }
    var wrap = document.getElementById('mm-cardwrap');
    wrap.innerHTML = '';
    wrap.appendChild(cardFor(r.meta));
    // 其他候選：高度吻合時相符度幾乎都是 0%，沒必要佔版面（收在 <details> 裡）；不確定時直接列出最接近的幾檔
    var oth = document.getElementById('mm-others');
    oth.innerHTML = '';
    var n = Math.min(res.results.length, 5);
    if (n > 1) {
      var holder = oth;
      if (res.verdict === 'sure') {
        var det = el('details'), sm = el('summary', '', '看其他候選（通常不用看）');
        sm.style.cursor = 'pointer';
        det.appendChild(sm); oth.appendChild(det); holder = det;
        if (i !== 0) det.open = true;
      } else {
        oth.appendChild(document.createTextNode('最接近的幾檔（點一下看那一檔）：'));
      }
      for (var k = 0; k < n; k++) {
        (function (k) {
          var rr = res.results[k];
          var ch = el('button', 'mm-chip' + (k === i ? ' on' : ''), '#' + rr.rank + ' ' + rr.code + ' ' + rr.name + ' · ' + rr.sim.toFixed(0) + '%');
          ch.type = 'button';
          ch.addEventListener('click', function () { showCandidate(k); });
          holder.appendChild(ch);
        })(k);
      }
    }
    if (document.getElementById('mm-verify').classList.contains('open')) drawVerify();
  }

  function drawVerify() {
    var res = state.res, i = state.sel, r = res.results[i];
    var fit = res.fits[i];
    if (!fit) { document.getElementById('mm-verify').classList.remove('open'); return; }
    drawFit(document.getElementById('mm-cv1'), state.img, res, fit);
    var im = new Image();
    im.onload = function () { drawDbChart(document.getElementById('mm-cv2'), im, r); };
    im.src = r.meta.img;
  }

  function locate(meta) {
    var card = pageCardFor(meta);
    if (!card) { alert('頁面清單裡找不到 ' + meta.code + '（可能網站剛更新，請重新整理後再試）'); return; }
    var panel = card.closest('.panel');
    try {
      if (panel && !panel.classList.contains('active') && typeof window.showTab === 'function') window.showTab(panel.id.replace('panel-', ''));
      if (card.classList.contains('hidden')) {                       // 被篩選條件藏起來 → 清掉篩選
        ['filterVol', 'filterFutures', 'filterWarrant'].forEach(function (id) { var c = document.getElementById(id); if (c) c.checked = false; });
        if (typeof window.selectSector === 'function') { /* 產業篩選由 showTab 已重置 */ }
        if (typeof window.applyFilters === 'function') window.applyFilters();
      }
    } catch (e) { /* 頁面函式不在就算了 */ }
    closeModal();
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('mm-flash'); void card.offsetWidth; card.classList.add('mm-flash');
  }

  // ---------------------------------------------------------------- 流程
  var runId = 0;
  async function handleFile(file) {
    if (!file || !/^image\//.test(file.type || 'image/')) { return; }
    var my = ++runId;
    openModal();
    body.innerHTML = '<div class="mm-loading"><div class="mm-spin"></div>解析截圖並比對中…</div>';
    try {
      var img = await readImage(file);
      var res = await runMatch(img);
      if (my !== runId) return;                                      // 已經有更新的一次
      renderResult(img, res);
    } catch (e) {
      if (my !== runId) return;
      body.innerHTML = '';
      var er = el('div', 'mm-err');
      er.innerHTML = '<b>比對失敗</b><br>' + String(e && e.message || e).replace(/</g, '&lt;') +
        '<br>可能是比對資料庫（match_index.json / match_index.bin）尚未發布，或網路暫時有問題。請重新整理後再試。';
      body.appendChild(er);
    }
  }

  btn.addEventListener('mouseenter', preload);
  btn.addEventListener('touchstart', preload, { passive: true });
  btn.addEventListener('click', function () { preload(); fileInput.value = ''; fileInput.click(); });
  fileInput.addEventListener('change', function () { if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]); });

  document.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type)) { handleFile(items[i].getAsFile()); e.preventDefault(); return; }
    }
  });
  var dragDepth = 0;
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }
  document.addEventListener('dragenter', function (e) { if (hasFiles(e)) { dragDepth++; dropHint.classList.add('on'); } });
  document.addEventListener('dragleave', function (e) { if (hasFiles(e)) { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropHint.classList.remove('on'); } });
  document.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; dropHint.classList.remove('on');
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  // 給測試用（uitest.py）：網址加 ?shot=/tests/xxx.png 會自動載入該圖
  window.MatchUI = { handleFile: handleFile, state: function () { return state; } };
  var qs = new URLSearchParams(location.search).get('shot');
  if (qs) {
    fetch(qs).then(function (r) { return r.blob(); }).then(function (b) { return handleFile(new File([b], 'shot.png', { type: b.type || 'image/png' })); });
  }
})();
