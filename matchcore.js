/* matchcore.js — 截圖比對的核心（純運算，不碰 DOM；瀏覽器主執行緒與 Web Worker 都能用）
 *
 * 這是 shotparse.py（解析截圖）與 matcher.py（仿射擬合比對）的 JavaScript 移植，邏輯逐段對照；
 * 連 Python 的「四捨五入取偶數」都對齊（pyround），所以兩邊的結果可以逐項比對（見 jstest.py）。
 *
 * 用法（RGBA 像素來自 canvas.getImageData）：
 *   const q  = MatchCore.parseShot(rgba, w, h);              // 截圖 → 逐根K棒特徵
 *   const db = await MatchCore.loadIndex('./');              // 網站發布的 match_index.json/.bin
 *   const qq = MatchCore.prepareQuery(q);
 *   const res = MatchCore.scoreAll(qq, db, {maxOff: 60, minOff: -5});
 *   const rows = MatchCore.rank(res, db, 10);
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ 小工具
  function pyround(x) {                    // Python round()：.5 時取偶數
    const f = Math.floor(x), d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return (f % 2 === 0) ? f : f + 1;
  }
  function median(arr) {
    const a = Array.from(arr).sort((x, y) => x - y), n = a.length;
    if (!n) return NaN;
    return n % 2 ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }
  function mean(arr) { let s = 0; for (const v of arr) s += v; return s / arr.length; }

  // 1D 布林陣列（以函式取值）→ 連續區段 [start,end]（含）
  function runsOf(get, lo, hi) {
    const runs = [];
    let inRun = false, s = 0;
    for (let i = lo; i < hi; i++) {
      if (get(i)) { if (!inRun) { s = i; inRun = true; } }
      else if (inRun) { runs.push([s, i - 1]); inRun = false; }
    }
    if (inRun) runs.push([s, hi - 1]);
    return runs;
  }

  // ------------------------------------------------------------------ 形態學（距離轉換法）
  const INF = 1e20;
  // Felzenszwalb 1D 平方距離轉換；f: 輸入(0=特徵點, INF=非特徵)，d: 輸出
  function edt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      d[q] = dq * dq + f[v[k]];
    }
  }
  // 每個像素到最近「特徵點(isFeature=1)」的平方距離
  function edt2(isFeature, w, h) {
    const g = new Float64Array(w * h);
    const m = Math.max(w, h);
    const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
    for (let x = 0; x < w; x++) {                     // 先對每一欄
      for (let y = 0; y < h; y++) f[y] = isFeature[y * w + x] ? 0 : INF;
      edt1d(f, h, d, v, z);
      for (let y = 0; y < h; y++) g[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {                     // 再對每一列
      for (let x = 0; x < w; x++) f[x] = g[y * w + x];
      edt1d(f, w, d, v, z);
      for (let x = 0; x < w; x++) g[y * w + x] = d[x];
    }
    return g;
  }
  // 等同 scipy.ndimage.binary_opening(mask, structure=圓盤(r))，邊界外視為 0
  function openDisk(mask, w, h, r) {
    const P = r + 1, W = w + 2 * P, H = h + 2 * P;
    const zeros = new Uint8Array(W * H);              // 特徵點 = 背景(0)或補的邊界
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ix = x - P, iy = y - P;
        zeros[y * W + x] = (ix < 0 || iy < 0 || ix >= w || iy >= h || !mask[iy * w + ix]) ? 1 : 0;
      }
    }
    const d2 = edt2(zeros, W, H);
    const E = new Uint8Array(w * h);                  // 侵蝕：到最近 0 的距離² > r²
    const r2 = r * r;
    let any = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d2[(y + P) * W + (x + P)] > r2) { E[y * w + x] = 1; any = true; }
    }
    const out = new Uint8Array(w * h);
    if (!any) return out;
    const d2b = edt2(E, w, h);                         // 膨脹：到最近侵蝕後前景的距離² <= r²
    for (let i = 0; i < w * h; i++) out[i] = d2b[i] <= r2 ? 1 : 0;
    return out;
  }
  // 方形結構元素 (2*rad+1)² 的膨脹（可分離的最大值濾波），邊界外視為 0
  function dilateSquare(mask, w, h, rad) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 0;
        const a = Math.max(0, x - rad), b = Math.min(w - 1, x + rad);
        for (let xx = a; xx <= b; xx++) if (mask[y * w + xx]) { v = 1; break; }
        tmp[y * w + x] = v;
      }
    }
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - rad), b = Math.min(h - 1, y + rad);
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let yy = a; yy <= b; yy++) if (tmp[yy * w + x]) { v = 1; break; }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ 顏色遮罩（相對式，抗壓縮）
  function colorMasks(rgba, n) {
    const redS = new Uint8Array(n), grnS = new Uint8Array(n), yel = new Uint8Array(n), mar = new Uint8Array(n),
      whi = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4, R = rgba[o], G = rgba[o + 1], B = rgba[o + 2];
      const mxGB = G > B ? G : B, mxRB = R > B ? R : B;
      redS[i] = (R >= 170 && G <= 90 && B <= 90 && R - mxGB >= 100) ? 1 : 0;
      grnS[i] = (G >= 150 && R <= 110 && B <= 130 && G - mxRB >= 70) ? 1 : 0;
      const mRG = R < G ? R : G;
      yel[i] = (mRG >= 82 && mRG - B >= 30 && Math.abs(R - G) <= 50) ? 1 : 0;
      mar[i] = (R - G >= 28 && B - G >= 10 && R >= 50 && R <= 215 && B <= 160 && R >= B) ? 1 : 0;
      const mn = mRG < B ? mRG : B, mx = (R > G ? R : G) > B ? (R > G ? R : G) : B;
      whi[i] = (mn >= 105 && mx - mn <= 28) ? 1 : 0;
    }
    return { redS, grnS, yel, mar, whi };
  }

  function estimateBg(rgba, n) {
    const counts = new Int32Array(43 * 43 * 43);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      counts[((rgba[o] / 6 | 0) * 43 + (rgba[o + 1] / 6 | 0)) * 43 + (rgba[o + 2] / 6 | 0)]++;
    }
    let best = 0;
    for (let k = 1; k < counts.length; k++) if (counts[k] > counts[best]) best = k;
    let sr = 0, sg = 0, sb = 0, c = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (((rgba[o] / 6 | 0) * 43 + (rgba[o + 1] / 6 | 0)) * 43 + (rgba[o + 2] / 6 | 0) === best) {
        sr += rgba[o]; sg += rgba[o + 1]; sb += rgba[o + 2]; c++;
      }
    }
    return [sr / c, sg / c, sb / c];
  }

  function overlayMask(rgba, w, h, bg, bodyW, redS, grnS) {
    const n = w * h;
    const nonbg = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      nonbg[i] = (Math.abs(rgba[o] - bg[0]) + Math.abs(rgba[o + 1] - bg[1]) + Math.abs(rgba[o + 2] - bg[2]) > 45) ? 1 : 0;
    }
    const r = Math.max(6, pyround(0.7 * bodyW));
    const big = openDisk(nonbg, w, h, r);                       // 圓形大頭貼整塊保留，K棒/線條被洗掉
    const body = new Uint8Array(n);
    for (let i = 0; i < n; i++) body[i] = (redS[i] || grnS[i]) ? 1 : 0;
    const bodyD = dilateSquare(body, w, h, 1);                  // K棒實體本身絕不算干擾物
    for (let i = 0; i < n; i++) if (bodyD[i]) big[i] = 0;
    for (let y = 0; y < h; y++) {                               // 影片黑邊：整列幾乎都是純黑
      let cnt = 0;
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (Math.max(rgba[o], rgba[o + 1], rgba[o + 2]) <= 12) cnt++;
      }
      if (cnt / w >= 0.35) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          if (Math.max(rgba[o], rgba[o + 1], rgba[o + 2]) <= 12) big[y * w + x] = 1;
        }
      }
    }
    return dilateSquare(big, w, h, 2);
  }

  // ------------------------------------------------------------------ 連續線追蹤（Viterbi）
  function interpGaps(path, maxGap) {
    const out = Float64Array.from(path);
    let prev = -1;
    for (let i = 0; i < out.length; i++) {
      if (!Number.isFinite(path[i])) continue;
      if (prev >= 0 && i - prev > 1 && i - prev <= maxGap + 1) {
        for (let k = prev + 1; k < i; k++) out[k] = path[prev] + (path[i] - path[prev]) * (k - prev) / (i - prev);
      }
      prev = i;
    }
    return out;
  }

  function traceLine(mask, weight, w, x0, x1, y0, y1, maxThick, maxGap, missPen, reward, jump0, jumpPerCol) {
    maxGap = maxGap === undefined ? 21 : maxGap;
    missPen = missPen === undefined ? 0.6 : missPen;
    reward = reward === undefined ? 3.0 : reward;
    jump0 = jump0 === undefined ? 3.0 : jump0;
    jumpPerCol = jumpPerCol === undefined ? 0.8 : jumpPerCol;
    const ncol = x1 - x0;
    const candC = [], candY = [], perCol = new Array(ncol);
    for (let c = 0; c < ncol; c++) {
      const x = x0 + c, lst = [];
      const merged = [];
      for (const [s, e] of runsOf((yy) => mask[yy * w + x], y0, y1)) {
        if (merged.length && s - merged[merged.length - 1][1] <= 2) merged[merged.length - 1][1] = e;   // 容許 1 列縫隙
        else merged.push([s, e]);
      }
      for (const [s, e] of merged) {
        if (e - s + 1 > maxThick) continue;                      // 太粗＝手繪標記/文字
        let sw = 0, sy = 0;
        for (let yy = s; yy <= e; yy++) { const wv = weight[yy * w + x]; sw += wv; sy += yy * wv; }
        if (sw <= 0) continue;
        lst.push(candY.length); candC.push(c); candY.push(sy / sw + 0.5);
      }
      perCol[c] = lst;
    }
    const n = candY.length;
    const out = new Float64Array(ncol).fill(NaN);
    if (!n) return out;
    const best = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
    for (let c = 0; c < ncol; c++) {
      for (const j of perCol[c]) {
        const yj = candY[j];
        let b = 8.0 - reward, p = -1;                            // 從頭開始的成本（鼓勵走完整條）
        for (let g = 1; g <= maxGap + 1; g++) {
          const cc = c - g;
          if (cc < 0) break;
          for (const i of perCol[cc]) {
            const dy = Math.abs(candY[i] - yj);
            if (dy > jump0 + jumpPerCol * g) continue;
            const cost = best[i] + dy * 1.2 / (1 + 0.15 * (g - 1)) + missPen * (g - 1) - reward;
            if (cost < b) { b = cost; p = i; }
          }
        }
        best[j] = b; prev[j] = p;
      }
    }
    let j = 0;
    for (let i = 1; i < n; i++) if (best[i] < best[j]) j = i;
    while (j >= 0) { out[candC[j]] = candY[j]; j = prev[j]; }
    return interpGaps(out, maxGap);
  }

  function thickLimit(mask, w, x0, x1, y0, y1, cap) {
    cap = cap || 14;
    const hist = new Int32Array(cap + 1);
    let any = false;
    for (let x = x0; x < x1; x += 2) {
      for (const [s, e] of runsOf((yy) => mask[yy * w + x], y0, y1)) {
        const t = e - s + 1;
        if (t <= cap) { hist[t]++; any = true; }
      }
    }
    if (!any) return 3;
    let t = 0;
    for (let k = 1; k <= cap; k++) if (hist[k] > hist[t]) t = k;
    return Math.max(3, t + Math.max(1, pyround(0.5 * t)));
  }

  // ------------------------------------------------------------------ 截圖解析
  function parseShot(rgba, w, h) {
    const n = w * h;
    const bg = estimateBg(rgba, n);
    const info = { h, w, bg: bg.map(Math.round), ok: false, notes: [] };
    const fail = { info, K: 0 };
    const dist = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      dist[i] = Math.abs(rgba[o] - bg[0]) + Math.abs(rgba[o + 1] - bg[1]) + Math.abs(rgba[o + 2] - bg[2]);
    }
    const { redS: red0, grnS: grn0, yel, mar, whi } = colorMasks(rgba, n);

    // ---- 1. K棒實體（先不排除干擾物，量出實體寬度，再決定干擾物遮罩的圓盤大小）----
    const both = new Uint8Array(n);
    for (let i = 0; i < n; i++) both[i] = (red0[i] || grn0[i]) ? 1 : 0;
    let comps = labelComps(both, red0, w, h).filter((c) => c.w >= 3 && c.area >= 8);
    if (comps.length < 3) { info.notes.push('找不到足夠的K棒實體（要有純紅/純綠的K棒）'); return fail; }
    const tall = comps.filter((c) => c.h >= 3).map((c) => c.w);
    const wmed = median(tall.length ? tall : comps.map((c) => c.w));
    comps = comps.filter((c) => (0.55 * wmed <= c.w && c.w <= 1.7 * wmed) ||
      (c.w >= 2 && c.w < 0.55 * wmed && (c.x0 <= 0 || c.x1 >= w)));
    if (comps.length < 3) { info.notes.push('K棒實體大小不一致，無法判定'); return fail; }
    const ov = overlayMask(rgba, w, h, bg, wmed, red0, grn0);
    comps.sort((a, b) => a.x0 - b.x0);
    const cx = comps.map((c) => (c.x0 + c.x1) / 2);
    const edge = comps.map((c) => c.x0 <= 0 || c.x1 >= w);

    // ---- 2. 推算K棒間距與每根的位置 ----
    const dAll = [];
    for (let i = 1; i < cx.length; i++) { const dd = cx[i] - cx[i - 1]; if (dd > 0.4 * wmed) dAll.push(dd); }
    if (!dAll.length) { info.notes.push('K棒間距無法判定'); return fail; }
    const low = dAll.slice().sort((a, b) => a - b).slice(0, Math.max(1, Math.ceil(dAll.length / 2)));
    const pEst = median(low);
    const single = dAll.filter((v) => v > 0.75 * pEst && v < 1.3 * pEst);
    const p0 = single.length ? mean(single) : pEst;
    let good = edge.map((e) => !e);
    if (good.filter(Boolean).length < 2) good = good.map(() => true);
    let pitch = p0, xFirst = cx[0];
    const kIdx = new Array(cx.length).fill(0);
    for (let it = 0; it < 4; it++) {
      kIdx[0] = 0;
      for (let j = 1; j < cx.length; j++) kIdx[j] = kIdx[j - 1] + pyround((cx[j] - cx[j - 1]) / pitch);
      const gk = [], gx = [];
      for (let j = 0; j < cx.length; j++) if (good[j]) { gk.push(kIdx[j]); gx.push(cx[j]); }
      if (new Set(gk).size < 2) break;
      const mk = mean(gk), mx = mean(gx);
      let sxx = 0, sxy = 0;
      for (let j = 0; j < gk.length; j++) { sxx += (gk[j] - mk) * (gk[j] - mk); sxy += (gk[j] - mk) * (gx[j] - mx); }
      pitch = sxy / sxx; xFirst = mx - pitch * mk;
    }
    let kMin = Math.min(...kIdx), kMax = Math.max(...kIdx);

    // 平盤K棒（開=收）實體只有一條 1px 細線，顏色被壓縮得很淡：用寬鬆門檻補找（範圍內漏掉的＋範圍兩端再外一根）
    const softR = new Uint8Array(n), softG = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (ov[i]) continue;
      const o = i * 4, R = rgba[o], G = rgba[o + 1], B = rgba[o + 2];
      softR[i] = (R >= 120 && R - Math.max(G, B) >= 70) ? 1 : 0;
      softG[i] = (G >= 110 && G - Math.max(R, B) >= 60) ? 1 : 0;
    }
    function softBodyAt(xcen) {
      const c0 = pyround(xcen - wmed * 0.3), c1 = pyround(xcen + wmed * 0.3) + 1;
      if (c0 < 0 || c1 > w) return null;
      const need = Math.max(2, Math.trunc(wmed * 0.4));
      let best = null;
      for (const [isRed, m] of [[true, softR], [false, softG]]) {
        const rows = [];
        for (let y = 0; y < h; y++) {
          let s = 0;
          for (let x = c0; x < c1; x++) s += m[y * w + x];
          if (s >= need) rows.push(y);
        }
        if (!rows.length) continue;
        const cx0 = pyround(xcen), okRows = [];
        for (const y of rows) {
          let l = cx0, r = cx0;
          while (l > 0 && m[y * w + l - 1]) l--;
          while (r < w - 1 && m[y * w + r + 1]) r++;
          if (0.5 * wmed <= (r - l + 1) && (r - l + 1) <= 1.5 * wmed) okRows.push(y);
        }
        if (okRows.length && (best === null || okRows.length > best[3])) {
          best = [isRed, okRows[0], okRows[okRows.length - 1] + 1, okRows.length];
        }
      }
      return best === null ? null : best.slice(0, 3);
    }
    const ext = [];
    for (let k = kMax + 1; xFirst + k * pitch + wmed * 0.3 < w; k++) {
      const r = softBodyAt(xFirst + k * pitch);
      if (r === null) break;
      ext.push([k, r]);
    }
    for (let k = kMin - 1; xFirst + k * pitch - wmed * 0.3 >= 0; k--) {
      const r = softBodyAt(xFirst + k * pitch);
      if (r === null) break;
      ext.push([k, r]);
    }
    if (ext.length) {
      kMin = Math.min(kMin, ...ext.map((e) => e[0]));
      kMax = Math.max(kMax, ...ext.map((e) => e[0]));
      info.notes.push(`以寬鬆顏色門檻補到 ${ext.length} 根平盤/薄K棒`);
    }
    const K = kMax - kMin + 1;
    const xc = new Float64Array(K);
    for (let i = 0; i < K; i++) xc[i] = xFirst + (kMin + i) * pitch;
    info.pitch = pitch; info.K = K; info.wmed = wmed;

    const nanArr = () => new Float64Array(K).fill(NaN);
    const out = {
      K, xc, pitch, up: new Uint8Array(K), hasBody: new Uint8Array(K),
      hi: nanArr(), lo: nanArr(), bt: nanArr(), bb: nanArr(), d: nanArr(), u: nanArr(),
      hist: nanArr(), hcol: new Int8Array(K).fill(-1), dif: nanArr(), dea: nanArr(),
      zero: NaN, covered: new Uint8Array(K), edge: new Uint8Array(K), split: null,
    };
    for (let ci = 0; ci < comps.length; ci++) {
      const c = comps[ci], i = kIdx[ci] - kMin;
      if (out.hasBody[i]) { out.bt[i] = Math.min(out.bt[i], c.y0); out.bb[i] = Math.max(out.bb[i], c.y1); }   // 被線切成兩塊→聯集
      else { out.bt[i] = c.y0; out.bb[i] = c.y1; out.up[i] = c.red ? 1 : 0; out.hasBody[i] = 1; }
      out.edge[i] = edge[ci] ? 1 : 0;
    }
    for (const [kk, r] of ext) {
      const i = kk - kMin;
      out.up[i] = r[0] ? 1 : 0; out.bt[i] = r[1]; out.bb[i] = r[2]; out.hasBody[i] = 1;
    }
    for (let i = 0; i < K; i++) {
      if (out.hasBody[i]) continue;
      const r = softBodyAt(xc[i]);
      if (r !== null) { out.up[i] = r[0] ? 1 : 0; out.bt[i] = r[1]; out.bb[i] = r[2]; out.hasBody[i] = 1; }
    }

    // ---- 3. 價格 / MACD 分面板 ----
    const xa = Math.max(0, Math.trunc(xc[0] - pitch / 2));
    const xb = Math.min(w, Math.trunc(xc[K - 1] + pitch / 2) + 1);
    let lastBodyBot = -Infinity;
    for (let i = 0; i < K; i++) if (Number.isFinite(out.bb[i]) && out.bb[i] > lastBodyBot) lastBodyBot = out.bb[i];
    // 零軸：長長的灰色水平線
    const gcnt = new Int32Array(h);
    for (let y = 0; y < h; y++) {
      let cnt = 0;
      for (let x = xa; x < xb; x++) {
        const i = y * w + x;
        if (ov[i]) continue;
        const o = i * 4, R = rgba[o], G = rgba[o + 1], B = rgba[o + 2], mean3 = (R + G + B) / 3;
        if (Math.abs(R - G) <= 14 && Math.abs(G - B) <= 18 && mean3 >= 70 && mean3 <= 175) cnt++;
      }
      gcnt[y] = cnt;
    }
    const thr = 0.28 * (xb - xa);
    const rows0 = [];
    for (let y = 0; y < h; y++) if (gcnt[y] >= thr && y > lastBodyBot) rows0.push(y);
    let yZero = null;
    if (rows0.length) {
      const set = new Uint8Array(h);
      for (const y of rows0) set[y] = 1;
      let bestRun = null, bestSum = -1;
      for (const [s, e] of runsOf((y) => set[y], 0, h)) {
        let sum = 0;
        for (let y = s; y <= e; y++) sum += gcnt[y];
        if (sum > bestSum) { bestSum = sum; bestRun = [s, e]; }
      }
      let sw = 0, sy = 0;
      for (let y = bestRun[0]; y <= bestRun[1]; y++) { sw += gcnt[y]; sy += y * gcnt[y]; }
      yZero = sy / sw + 0.5;
      out.zero = yZero;
    }
    // 內容列：找「價格面板」與「MACD 面板」之間的大空隙（每列至少要有寬度 2.5% 的內容才算有東西）
    const need = Math.max(3, Math.trunc(0.025 * (xb - xa)));
    const rowsHas0 = new Uint8Array(h);
    for (let y = 0; y < h; y++) {
      let cnt = 0;
      for (let x = xa; x < xb; x++) { const i = y * w + x; if (dist[i] >= 60 && !ov[i]) cnt++; }
      rowsHas0[y] = cnt >= need ? 1 : 0;
    }
    const rowsHas = new Uint8Array(h);
    for (let y = 0; y < h; y++) rowsHas[y] = (rowsHas0[y] || (y > 0 && rowsHas0[y - 1]) || (y < h - 1 && rowsHas0[y + 1])) ? 1 : 0;
    let split = null;
    if (yZero !== null) {
      const yz = Math.trunc(yZero);
      const gmin = Math.max(10, Math.trunc(0.08 * h));
      let empty = runsOf((y) => !rowsHas[y], 0, yz);
      empty = empty.filter((r) => r[1] - r[0] + 1 >= gmin && r[0] > lastBodyBot - 1);
      if (empty.length) {
        let bestR = empty[0];
        for (const r of empty) if (r[1] - r[0] > bestR[1] - bestR[0]) bestR = r;
        split = Math.floor((bestR[0] + bestR[1]) / 2);
      }
    }
    out.split = split;
    const priceBot = split !== null ? split : h;
    info.zero = yZero; info.split = split;

    // ---- 4. 影線 ----
    let bgSum = bg[0] + bg[1] + bg[2];
    for (let i = 0; i < K; i++) {
      if (!out.hasBody[i]) continue;
      const cols = [];
      for (const o of [-1, 0, 1]) { const c = pyround(xc[i]) + o; if (c >= 0 && c < w) cols.push(c); }
      const prof = (y) => {                                       // 暗灰細線（亮度比底色高，且不是黃/洋紅線）
        for (const c of cols) {
          const idx = y * w + c, o = idx * 4;
          if (ov[idx] || yel[idx] || mar[idx]) continue;
          if (rgba[o] + rgba[o + 1] + rgba[o + 2] - bgSum >= 60) return true;
        }
        return false;
      };
      const lineOk = (y) => {
        for (const c of cols) { const idx = y * w + c; if (yel[idx] || mar[idx] || whi[idx]) return true; }
        return false;
      };
      const top = Math.trunc(out.bt[i]), bot = Math.trunc(out.bb[i]);
      let hi = top, y = top - 1, gap = 0;
      while (y >= 0 && gap <= 3) {
        if (prof(y)) { hi = y; gap = 0; }
        else if (lineOk(y)) { /* 線壓在影線上：不算斷 */ }
        else gap += 1;
        y -= 1;
      }
      let lo = bot; y = bot; gap = 0;
      while (y < priceBot && gap <= 3) {
        if (prof(y)) { lo = y + 1; gap = 0; }
        else if (lineOk(y)) { /* 同上 */ }
        else gap += 1;
        y += 1;
      }
      out.hi[i] = hi; out.lo[i] = lo;
    }

    // ---- 5. 持股線(黃) 與 多空線(洋紅) ----
    const ymaskY = new Uint8Array(n), ymaskM = new Uint8Array(n);
    const wy = new Float32Array(n), wm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4, R = rgba[o], G = rgba[o + 1], B = rgba[o + 2];
      if (!ov[i]) { ymaskY[i] = yel[i]; ymaskM[i] = mar[i]; }
      wy[i] = Math.max(1, Math.min(R, G) - B);
      wm[i] = Math.max(1, R - G);
    }
    const gapc = Math.trunc(1.3 * wmed) + 2;
    const pathD = traceLine(ymaskY, wy, w, xa, xb, 0, priceBot, thickLimit(ymaskY, w, xa, xb, 0, priceBot), gapc);
    const pathU = traceLine(ymaskM, wm, w, xa, xb, 0, priceBot, thickLimit(ymaskM, w, xa, xb, 0, priceBot) + 1, gapc);
    const sample = (path, i) => {
      const c0 = pyround(xc[i]) - xa;
      let s = 0, c = 0;
      for (let k = Math.max(c0 - 1, 0); k < Math.min(c0 + 2, xb - xa); k++) if (Number.isFinite(path[k])) { s += path[k]; c++; }
      return c ? s / c : NaN;
    };
    for (let i = 0; i < K; i++) { out.d[i] = sample(pathD, i); out.u[i] = sample(pathU, i); }

    // ---- 6. MACD ----
    if (yZero !== null) {
      const yz = pyround(yZero);
      const mTop = split !== null ? split : Math.max(0, yz - Math.trunc(0.25 * h));
      for (let i = 0; i < K; i++) {
        const c = pyround(xc[i]);
        let bestLen = 0, bestVal = 0, bestCol = -1;
        for (let cc = c - 2; cc <= c + 2; cc++) {
          if (!(cc >= 0 && cc < w)) continue;
          const kinds = new Int8Array(h).fill(-1);                  // 每列的柱色（0紅 1綠 2藍），-1=不是柱
          for (let y = 0; y < h; y++) {
            const idx = y * w + cc, o = idx * 4;
            if (!(dist[idx] >= 55) || ov[idx]) continue;
            const R = rgba[o], G = rgba[o + 1], B = rgba[o + 2];
            if (B - R >= 40 && B - G >= 15 && B >= 90) kinds[y] = 2;
            if (G - R >= 14 && G - B >= 14 && G >= 70) kinds[y] = 1;
            if (R - G >= 25 && R - B >= 22 && R >= 70) kinds[y] = 0;
          }
          for (const [s, e] of runsOf((y) => kinds[y] >= 0, 0, h)) {
            if (e < mTop) continue;
            if (!(s <= yZero + 3 && e >= yZero - 4)) continue;        // 柱子從零軸長出來
            const upLen = s < yZero - 1 ? yZero - s : 0.0;
            const dnLen = e > yZero + 1 ? (e + 1) - yZero : 0.0;
            const L = Math.max(upLen, dnLen);
            if (L > bestLen) {
              const cnt = [0, 0, 0];
              for (let y = s; y <= e; y++) if (kinds[y] >= 0) cnt[kinds[y]]++;
              bestLen = L;
              bestVal = upLen >= dnLen ? upLen : -dnLen;
              bestCol = cnt[0] >= cnt[1] && cnt[0] >= cnt[2] ? 0 : (cnt[1] >= cnt[2] ? 1 : 2);
            }
          }
        }
        out.hist[i] = bestLen > 0 ? bestVal : 0.0;
        out.hcol[i] = bestCol;
      }
      const ywhite = new Uint8Array(n), mw = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        if (!ov[i]) ywhite[i] = whi[i];
        mw[i] = Math.max(1, Math.min(rgba[o], rgba[o + 1], rgba[o + 2]) - 60);
      }
      for (let y = Math.max(0, yz - 1); y < Math.min(h, yz + 2); y++) for (let x = 0; x < w; x++) ywhite[y * w + x] = 0;   // 零軸線本身
      const pathDif = traceLine(ywhite, mw, w, xa, xb, mTop, h, thickLimit(ywhite, w, xa, xb, mTop, h), gapc);
      const pathDea = traceLine(ymaskY, wy, w, xa, xb, mTop, h, thickLimit(ymaskY, w, xa, xb, mTop, h), gapc);
      for (let i = 0; i < K; i++) {
        const a1 = sample(pathDif, i), a2 = sample(pathDea, i);
        out.dif[i] = Number.isFinite(a1) ? yZero - a1 : NaN;
        out.dea[i] = Number.isFinite(a2) ? yZero - a2 : NaN;
      }
    }

    // 被大頭貼蓋住的K棒（MACD 區）：柱子/DIF/DEA 在那裡是「看不到」而不是「等於零」→ 當缺值
    if (yZero !== null) {
      const yz = pyround(yZero);
      for (let i = 0; i < K; i++) {
        const c = pyround(xc[i]);
        let cov = false;
        for (let y = Math.max(yz - 6, 0); y < Math.min(yz + 12, h) && !cov; y++) {
          for (let x = Math.max(c - 2, 0); x < Math.min(c + 3, w); x++) if (ov[y * w + x]) { cov = true; break; }
        }
        out.covered[i] = cov ? 1 : 0;
        if (cov) { out.hist[i] = NaN; out.hcol[i] = -1; }
      }
    }
    info.ok = true;
    out.info = info;
    return out;
  }

  // 8 連通區塊（掃描順序編號，與 scipy.ndimage.label 一致）
  function labelComps(mask, redMask, w, h) {
    const n = w * h, lab = new Uint8Array(n), stack = new Int32Array(n), comps = [];
    for (let i = 0; i < n; i++) {
      if (!mask[i] || lab[i]) continue;
      let sp = 0, x0 = w, x1 = -1, y0 = h, y1 = -1, area = 0, redCount = 0;
      stack[sp++] = i; lab[i] = 1;
      while (sp) {
        const p = stack[--sp], y = (p / w) | 0, x = p - y * w;
        area++; if (redMask[p]) redCount++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (mask[q] && !lab[q]) { lab[q] = 1; stack[sp++] = q; }
          }
        }
      }
      comps.push({ x0, x1: x1 + 1, y0, y1: y1 + 1, w: x1 + 1 - x0, h: y1 + 1 - y0, area, red: redCount > area / 2 });
    }
    return comps;
  }

  // ------------------------------------------------------------------ 比對（matcher.py）
  const PRICE_KEYS = ['hi', 'lo', 'bt', 'bb', 'd', 'u'];
  const PRICE_W = [1, 1, 1, 1, 1, 0.8];
  const MACD_KEYS = ['hist', 'dif', 'dea'];

  function prepareQuery(q) {
    const K = q.K, out = { K };
    const rev = (arr) => { const o = new Float64Array(K); for (let i = 0; i < K; i++) o[i] = arr[K - 1 - i]; return o; };
    const up = new Float64Array(K);
    for (let i = 0; i < K; i++) up[i] = q.hasBody[i] ? (q.up[i] ? 1 : 0) : NaN;
    out.up = rev(up);
    for (const k of PRICE_KEYS.concat(MACD_KEYS)) out[k] = rev(q[k]);
    const hc = new Float64Array(K);
    for (let i = 0; i < K; i++) hc[i] = q.hcol[i] >= 0 ? q.hcol[i] : NaN;
    out.hcol = rev(hc);
    const cov = rev(Float64Array.from(q.covered));
    for (const k of MACD_KEYS.concat(['hcol'])) for (let i = 0; i < K; i++) if (cov[i] > 0) out[k][i] = NaN;
    return out;
  }

  // 第 k 小（0 起算）的值，原地快速選取（Hoare 分割）
  function kthSmallest(a, n, k) {
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const pivot = a[(lo + hi) >> 1];
      let i = lo, j = hi;
      while (i <= j) {
        while (a[i] < pivot) i++;
        while (a[j] > pivot) j--;
        if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return a[k];
    }
    return a[k];
  }

  // 修剪最小平方：X(資料庫值,長 P)、Y(截圖值,長 P)、W0(基本權重)；nan 的點自動忽略
  // 回傳 {a, b, rms, nvalid}；邏輯與 matcher._trimmed_fit 逐步對應
  function trimmedFit(X, Y, W0, P, keep, iters, origin, tmp) {
    let nvalid = 0;
    const valid = tmp.valid, w = tmp.w, R = tmp.R, absr = tmp.absr;
    for (let i = 0; i < P; i++) {
      const ok = Number.isFinite(X[i]) && Number.isFinite(Y[i]);
      valid[i] = ok ? 1 : 0; w[i] = ok ? W0[i] : 0; if (ok) nvalid++;
    }
    let a = 0, b = 0, rms = Infinity;
    if (nvalid < 4) return { a: NaN, b: NaN, rms: Infinity, nvalid };
    const kk = Math.max(Math.ceil(keep * nvalid), 1);
    for (let it = 0; it <= iters; it++) {
      let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let i = 0; i < P; i++) {
        if (!valid[i]) continue;
        const wi = w[i], xi = X[i], yi = Y[i];
        sw += wi; sx += wi * xi; sy += wi * yi; sxx += wi * xi * xi; sxy += wi * xi * yi;
      }
      if (origin) { a = sxy / sxx; b = 0; }
      else { const den = sw * sxx - sx * sx; a = (sw * sxy - sx * sy) / den; b = (sy - a * sx) / sw; }
      let m = 0;
      for (let i = 0; i < P; i++) {
        if (!valid[i]) continue;
        R[i] = Y[i] - (a * X[i] + b);
        absr[m++] = Math.abs(R[i]);
      }
      const thr = kthSmallest(absr, m, Math.min(kk - 1, m - 1));   // 第 kk 小的殘差（原地快速選取，不排序、不配置記憶體）
      let sw2 = 0, ss = 0;
      for (let i = 0; i < P; i++) {
        if (!valid[i]) { w[i] = 0; continue; }
        const sel = Math.abs(R[i]) <= thr;
        w[i] = sel ? W0[i] : 0;
        if (sel) { sw2 += W0[i]; ss += W0[i] * R[i] * R[i]; }
      }
      rms = Math.sqrt(ss / sw2);
    }
    if (!Number.isFinite(rms)) rms = Infinity;
    return { a, b, rms, nvalid };
  }

  function makeTmp(P) {
    return { valid: new Uint8Array(P), w: new Float64Array(P), R: new Float64Array(P), absr: new Float64Array(P) };
  }

  function dbValue(db, field, s, t) {
    if (t < 0 || t >= db.nkeep) return NaN;
    return db.f[field][s * db.nkeep + t];
  }

  function scoreAll(q, db, opts) {
    opts = opts || {};
    const maxOff = opts.maxOff === undefined ? 60 : opts.maxOff;
    const minOff = opts.minOff === undefined ? 0 : opts.minOff;
    const minFrac = opts.minFrac === undefined ? 0.5 : opts.minFrac;
    const prune = !!opts.prune;
    const K = q.K, S = db.S, M = Math.max(0, -minOff), O1 = M + maxOff + 1;
    const P6 = K * 6, P3 = K * 3;
    const Yp = new Float64Array(P6), Wp = new Float64Array(P6), Ym = new Float64Array(P3), Wm = new Float64Array(P3);
    for (let k = 0; k < K; k++) {
      for (let f = 0; f < 6; f++) { Yp[k * 6 + f] = q[PRICE_KEYS[f]][k]; Wp[k * 6 + f] = PRICE_W[f]; }
      for (let f = 0; f < 3; f++) { Ym[k * 3 + f] = q[MACD_KEYS[f]][k]; Wm[k * 3 + f] = 1; }
    }
    let hiMax = -Infinity, loMin = Infinity;                          // 像素座標 y 向下：影線上端 hi 的 y 小
    for (let k = 0; k < K; k++) {
      if (Number.isFinite(q.lo[k]) && q.lo[k] > hiMax) hiMax = q.lo[k];
      if (Number.isFinite(q.hi[k]) && q.hi[k] < loMin) loMin = q.hi[k];
    }
    const Rq = Math.max(hiMax - loMin, 1.0);
    let Rm = 0, nm = 0;
    for (let i = 0; i < P3; i++) if (Number.isFinite(Ym[i])) { nm++; if (Math.abs(Ym[i]) > Rm) Rm = Math.abs(Ym[i]); }
    const useMacd = nm >= 6 && Rm >= 3.0;
    let nQup = 0, nYp = 0;
    for (let k = 0; k < K; k++) if (Number.isFinite(q.up[k])) nQup++;
    for (let i = 0; i < P6; i++) if (Number.isFinite(Yp[i])) nYp++;

    const cost = new Float64Array(S * O1).fill(Infinity);
    const price = new Float64Array(S * O1).fill(Infinity), macd = new Float64Array(S * O1).fill(Infinity);
    const upmis = new Int16Array(S * O1), hcolmis = new Int16Array(S * O1);
    const Xp = new Float64Array(P6), Xm = new Float64Array(P3);
    const tmp6 = makeTmp(P6), tmp3 = makeTmp(P3);
    const NK = db.nkeep, FU = db.f.up, FH = db.f.hcol;
    const FP = PRICE_KEYS.map((k) => db.f[k]), FM = MACD_KEYS.map((k) => db.f[k]);

    for (let s = 0; s < S; s++) {
      const base = s * NK;
      for (let j = 0; j < O1; j++) {
        const off = j - M, idx = s * O1 + j;
        // 紅綠K序列（便宜，先算；prune 時差太多就不必擬合）
        let mis = 0, nup = 0;
        for (let k = 0; k < K; k++) {
          const t = off + k;
          if (t < 0 || t >= NK) continue;
          const dv = FU[base + t], qv = q.up[k];
          if (dv === dv && qv === qv) { nup++; if (dv !== qv) mis++; }      // x===x 即「不是 NaN」
        }
        upmis[idx] = mis;
        if (nup < 0.6 * nQup) continue;
        if (prune && mis > 0.4 * nup) continue;       // 紅綠K差 40% 以上，成本至少 0.1，不可能進「可能/吻合」
        for (let k = 0; k < K; k++) {
          const t = off + k, ok = t >= 0 && t < NK;
          for (let f = 0; f < 6; f++) Xp[k * 6 + f] = ok ? FP[f][base + t] : NaN;
          for (let f = 0; f < 3; f++) Xm[k * 3 + f] = ok ? FM[f][base + t] : NaN;
        }
        const fp = trimmedFit(Xp, Yp, Wp, P6, 0.8, 3, false, tmp6);
        if (!(fp.nvalid >= minFrac * nYp)) continue;
        const pr = fp.a > 0 ? fp.rms / Rq : Infinity;
        let mc = 0;
        if (useMacd) {
          const fm = trimmedFit(Xm, Ym, Wm, P3, 0.8, 3, true, tmp3);
          mc = fm.a > 0 ? fm.rms / Rm : Infinity;
        }
        let hm = 0, nh = 0;
        for (let k = 0; k < K; k++) {
          const t = off + k;
          if (t < 0 || t >= NK) continue;
          const dv = FH[base + t], qv = q.hcol[k];
          if (dv === dv && qv === qv) { nh++; if (dv !== qv) hm++; }
        }
        hcolmis[idx] = hm;
        const c = pr + (useMacd ? 0.6 * mc : 0) + 0.25 * (mis / Math.max(nup, 1)) + 0.08 * (hm / Math.max(nh, 1));
        price[idx] = pr; macd[idx] = mc;
        cost[idx] = Number.isFinite(c) ? c : Infinity;
      }
    }
    return { cost, price, macd, upmis, hcolmis, S, O1, minOff: -M, K, Rq, Rm, useMacd };
  }

  function rank(res, db, top) {
    const { cost, S, O1, minOff, K } = res;
    const rows = [];
    for (let s = 0; s < S; s++) {
      let bj = 0;
      for (let j = 1; j < O1; j++) if (cost[s * O1 + j] < cost[s * O1 + bj]) bj = j;
      const c = cost[s * O1 + bj];
      if (Number.isFinite(c)) rows.push({ cost: c, s, j: bj });
    }
    rows.sort((a, b) => a.cost - b.cost);
    const out = rows.slice(0, top || 10).map((r, i) => {
      const off = r.j + minOff, idx = r.s * O1 + r.j;
      return {
        rank: i + 1, s: r.s, off, cost: r.cost, kEff: K + Math.min(off, 0),
        price: res.price[idx], macd: res.macd[idx], upmis: res.upmis[idx], hcolmis: res.hcolmis[idx],
        sim: similarity(r.cost), code: db.meta[r.s].code, name: db.meta[r.s].name,
      };
    });
    return { top: out, all: rows };
  }

  // 單一候選 (股票 s, 位移 off) 的擬合：驗證圖用（預測的 K×6 價格點、K×3 MACD 點，最新在前）
  function explain(q, db, s, off) {
    const K = q.K, P6 = K * 6, P3 = K * 3;
    const Yp = new Float64Array(P6), Xp = new Float64Array(P6), Wp = new Float64Array(P6);
    const Ym = new Float64Array(P3), Xm = new Float64Array(P3), Wm = new Float64Array(P3);
    for (let k = 0; k < K; k++) {
      for (let f = 0; f < 6; f++) { Yp[k * 6 + f] = q[PRICE_KEYS[f]][k]; Xp[k * 6 + f] = dbValue(db, PRICE_KEYS[f], s, off + k); Wp[k * 6 + f] = PRICE_W[f]; }
      for (let f = 0; f < 3; f++) { Ym[k * 3 + f] = q[MACD_KEYS[f]][k]; Xm[k * 3 + f] = dbValue(db, MACD_KEYS[f], s, off + k); Wm[k * 3 + f] = 1; }
    }
    const fp = trimmedFit(Xp, Yp, Wp, P6, 0.8, 3, false, makeTmp(P6));
    const fm = trimmedFit(Xm, Ym, Wm, P3, 0.8, 3, true, makeTmp(P3));
    const predP = new Float64Array(P6), predM = new Float64Array(P3);
    for (let i = 0; i < P6; i++) predP[i] = fp.a * Xp[i] + fp.b;
    for (let i = 0; i < P3; i++) predM[i] = fm.a * Xm[i];
    return { a: fp.a, b: fp.b, am: fm.a, rms: fp.rms, rmsm: fm.rms, predP, predM };
  }

  // ------------------------------------------------------------------ 判定（engine.py）
  const SIM_ZERO = 0.15;
  const SURE_BY_K = [[8, 0.012], [12, 0.02], [1e9, 0.03]];
  const MAYBE_BY_K = [[8, 0.04], [14, 0.05], [19, 0.06], [27, 0.07], [1e9, 0.09]];
  function byK(table, K) { for (const [kmax, v] of table) if (K <= kmax) return v; return table[table.length - 1][1]; }
  function similarity(cost) { return Math.max(0, Math.min(1, 1 - cost / SIM_ZERO)) * 100; }
  function verdictOf(best, second, K) {
    if (best <= byK(SURE_BY_K, K) && second >= 2.5 * best) return 'sure';
    if (best <= byK(MAYBE_BY_K, K)) return 'maybe';
    return 'none';
  }

  // ------------------------------------------------------------------ 網站特徵索引（match_export.py 產生）
  function decodeIndex(meta, buf) {
    const raw = new Int16Array(buf), S = meta.stocks.length, NK = meta.nkeep, f = {};
    meta.fields.forEach((fd, fi) => {
      const arr = new Float32Array(S * NK), base = fi * S * NK;
      for (let i = 0; i < S * NK; i++) {
        const v = raw[base + i];
        arr[i] = v === meta.nan ? NaN : (fd.scaled ? v / meta.scale : v);
      }
      f[fd.name] = arr;
    });
    return { S, nkeep: NK, f, meta: meta.stocks, scan: meta.scan, built: meta.built, n: meta.stocks.map((s) => s.n) };
  }
  async function loadIndex(base) {
    const mr = await fetch(base + 'match_index.json', { cache: 'no-cache' });
    if (!mr.ok) throw new Error('讀不到 match_index.json（' + mr.status + '）');
    const meta = await mr.json();
    const br = await fetch(base + 'match_index.bin?v=' + encodeURIComponent(meta.built || ''), { cache: 'no-cache' });
    if (!br.ok) throw new Error('讀不到 match_index.bin（' + br.status + '）');
    return decodeIndex(meta, await br.arrayBuffer());
  }

  // ------------------------------------------------------------------ 一次做完：解析 + 比對 + 判定 + 驗證圖資料
  function runMatch(rgba, w, h, db, opts) {
    opts = opts || {};
    const t0 = Date.now();
    const q = parseShot(rgba, w, h);
    const res = { ok: false, notes: (q.info && q.info.notes) || [], info: q.info };
    if (!q.info || !q.info.ok || q.K < 3) { res.notes = res.notes.length ? res.notes : ['解析不到K棒']; return res; }
    res.parseMs = Date.now() - t0;
    const qq = prepareQuery(q);
    const t1 = Date.now();
    const sc = scoreAll(qq, db, { maxOff: opts.maxOff === undefined ? 60 : opts.maxOff,
      minOff: opts.minOff === undefined ? -5 : opts.minOff, prune: opts.prune !== false });
    const rk = rank(sc, db, opts.top || 10);
    res.matchMs = Date.now() - t1;
    if (!rk.top.length) { res.notes = ['沒有任何候選（K棒太少或資料庫為空）']; return res; }
    const second = rk.top.length > 1 ? rk.top[1].cost : 9;
    res.ok = true;
    res.K = q.K;
    res.results = rk.top;
    res.nCandidates = rk.all.length;
    res.verdict = verdictOf(rk.top[0].cost, second, rk.top[0].kEff);
    res.useMacd = sc.useMacd;
    const warn = [];
    if (q.K < 12) warn.push(`只解析出 ${q.K} 根K棒，根數越少越容易瞎湊出相似的，請多看驗證圖`);
    if (!sc.useMacd) warn.push('沒讀到足夠的 MACD（只用K棒+持股線+多空線比對）');
    let nu = 0, nd = 0;
    for (let i = 0; i < q.K; i++) { if (Number.isFinite(q.u[i])) nu++; if (Number.isFinite(q.d[i])) nd++; }
    if (nu < q.K * 0.5) warn.push('多空線沒讀到（沒有它，可辨識度會降低）');
    if (nd < q.K * 0.5) warn.push('持股線沒讀到');
    res.warnings = warn;
    // 驗證圖需要的資料：前幾名的擬合預測值＋截圖特徵
    res.q = { K: q.K, xc: Array.from(q.xc), zero: q.zero, pitch: q.pitch };
    res.fits = rk.top.slice(0, 5).map((r) => {
      const ex = explain(qq, db, r.s, r.off);
      return { s: r.s, off: r.off, predP: Array.from(ex.predP), predM: Array.from(ex.predM), a: ex.a, am: ex.am };
    });
    res.features = opts.withFeatures ? qToPlain(q) : undefined;
    return res;
  }

  function qToPlain(q) {
    const o = { K: q.K, zero: q.zero, split: q.split, pitch: q.pitch, notes: q.info.notes };
    for (const k of ['xc', 'hi', 'lo', 'bt', 'bb', 'd', 'u', 'hist', 'dif', 'dea', 'up', 'hasBody', 'hcol', 'covered', 'edge']) {
      o[k] = Array.from(q[k], (v) => (Number.isFinite(v) ? v : null));
    }
    return o;
  }

  root.MatchCore = {
    parseShot, prepareQuery, scoreAll, rank, explain, similarity, verdictOf, decodeIndex, loadIndex, runMatch, qToPlain,
    PRICE_KEYS, MACD_KEYS, pyround, version: 1,
  };
})(typeof self !== 'undefined' ? self : this);
