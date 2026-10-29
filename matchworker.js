/* matchworker.js — 在 Web Worker 裡跑 matchcore.js，比對時畫面不會卡住 */
importScripts('matchcore.js');

let DB = null;
let loading = null;

function ensureDb() {
  if (DB) return Promise.resolve(DB);
  if (!loading) {
    loading = MatchCore.loadIndex('').then((d) => { DB = d; return d; }, (e) => { loading = null; throw e; });
  }
  return loading;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    const db = await ensureDb();
    if (m.type === 'init') {
      self.postMessage({ id: m.id, ok: true, scan: db.scan, built: db.built, count: db.S });
    } else if (m.type === 'match') {
      const rgba = new Uint8ClampedArray(m.buffer);
      const res = MatchCore.runMatch(rgba, m.w, m.h, db, { maxOff: m.maxOff, minOff: m.minOff, prune: true });
      res.scan = db.scan;
      res.built = db.built;
      if (res.ok) res.results.forEach((r) => { r.meta = db.meta[r.s]; r.n = db.n[r.s]; });
      self.postMessage({ id: m.id, ok: true, result: res });
    }
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e) });
  }
};
