/* loader.cjs — ZCode 速率工具栏主进程 loader（v2）。
 * 由 patch.cjs 在 app.asar 入口 out/main/index.js 尾部追加一行 dynamic import 引入。
 * 职责：
 *  1) 向每个聊天窗口注入 overlay.js（含热更新：mtime 变化即重注入）；
 *  2) 触发式查询 ~/.zcode/cli/db/db.sqlite：fs.watch db 目录，一有写入（去抖 300ms）
 *     就查询并推送给窗口；空闲零查询零轮询，仅兜底心跳。优先在主进程内直接
 *     require("node:sqlite")（Electron 自带 Node 已支持，实测）；失败降级为
 *     ELECTRON_RUN_AS_NODE 子进程一次性查询（query-cli.cjs）。
 *  3) 每窗口焦点会话：监听客户端自带 IPC 通道 "zcode:sync-active-task-session"，
 *     查询时强制纳入，推送时按窗口附带 mine 字段（各窗口显示自己的会话）。
 *  4) 每次推送附带 config.json 的 show（显示项开关）与 pos（左/右位置），
 *     改配置即热生效，无需重启。
 * 任何失败只写日志，不影响客户端。 */
"use strict";
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { app, BrowserWindow, webContents } = require("electron");

const HERE = __dirname;
const OVERLAY = path.join(HERE, "overlay.js");
const QUERY_CLI = path.join(HERE, "query-cli.cjs");
const LOG_FILE = path.join(HERE, "loader.log");
const CONFIG = path.join(HERE, "config.json");

function readCfg() {
  const c = {
    min_interval_ms: 900,
    heartbeat_ms: 15000,
    hot_reload: true,
    show: { ttft: true, tps: true, e2e: true },
    pos: "left",
  };
  try {
    const user = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    Object.assign(c, user);
    c.show = Object.assign({ ttft: true, tps: true, e2e: true }, user.show || {});
    if (c.pos !== "right") c.pos = "left";
  } catch (e) {}
  return c;
}
let cfgCache = null;
let cfgMtime = 0;
function cfg() {
  let m = 0;
  try {
    m = fs.statSync(CONFIG).mtimeMs;
  } catch (e) {}
  if (!cfgCache || m !== cfgMtime) {
    cfgMtime = m;
    cfgCache = readCfg();
  }
  return cfgCache;
}

const logs = [];
function LOG(...a) {
  const line = "[rate-tb] " + a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  logs.push(line);
  if (logs.length > 200) logs.splice(0, logs.length - 200);
  try {
    fs.writeFileSync(LOG_FILE, logs.join("\n"));
  } catch (e) {}
  console.error(line);
}

/* ---------- overlay 注入 + 热更新 ---------- */
let overlaySrc = "";
let overlayMtime = 0;
try {
  overlaySrc = fs.readFileSync(OVERLAY, "utf8");
  overlayMtime = fs.statSync(OVERLAY).mtimeMs;
} catch (e) {
  LOG("overlay.js missing:", e.message);
}

function isWindowType(wc) {
  try {
    return wc.getType() === "window";
  } catch (e) {
    return false;
  }
}

function hotReloadIfChanged() {
  let m = 0;
  let src = "";
  try {
    m = fs.statSync(OVERLAY).mtimeMs;
    src = fs.readFileSync(OVERLAY, "utf8");
  } catch (e) {
    return;
  }
  if (m === overlayMtime) return;
  try {
    new Function(src);
  } catch (e) {
    LOG("overlay.js syntax not ready, skip:", e.message);
    return;
  }
  overlayMtime = m;
  overlaySrc = src;
  LOG("overlay.js changed, hot-reloading");
  for (const wc of webContents.getAllWebContents()) {
    if (!isWindowType(wc) || wc.isDestroyed()) continue;
    wc.executeJavaScript(
      '(function(){document.querySelectorAll(".rate-tb-root").forEach(function(el){el.remove()});window.__rateTbOverlay=false;})()',
      true,
    ).catch(() => {});
    injectOverlay(wc);
  }
}

function injectOverlay(wc) {
  if (!overlaySrc || !isWindowType(wc) || wc.isDestroyed()) return;
  wc.executeJavaScript(overlaySrc, true).catch(() => {});
}

/* ---------- 每窗口焦点会话（客户端自带通道，追加监听不影响原有处理） ---------- */
const IPC_ACTIVE_SID = "zcode:sync-active-task-session";
const activeSid = new Map(); // webContents.id -> 会话 id 或 ""
try {
  const { ipcMain } = require("electron");
  ipcMain.on(IPC_ACTIVE_SID, (e, sid) => {
    if (!e || !e.sender || e.sender.isDestroyed()) return;
    const s = typeof sid === "string" ? sid.trim() : "";
    const val = /^[A-Za-z0-9_-]{1,80}$/.test(s) ? s : "";
    const prev = activeSid.get(e.sender.id);
    activeSid.set(e.sender.id, val);
    if (prev !== val) scheduleQuery(400);
  });
} catch (e) {
  LOG("ipc hook failed:", e.message);
}

/* ---------- 查询：进程内优先，子进程降级 ---------- */
let inProcDb = null; // 打开的 DatabaseSync（只读，长期持有）
let inProcFailed = false;
function queryInProc(sids) {
  const { openDb, querySessions } = require(path.join(HERE, "query-lib.cjs"));
  if (!inProcDb) inProcDb = openDb();
  return querySessions(inProcDb, sids);
}

let busy = false;
let lastQueryAt = 0;
let lastStamp = 0;
let lastWants = "";

function pushAll(payload) {
  for (const wc of webContents.getAllWebContents()) {
    if (!isWindowType(wc) || wc.isDestroyed() || !payload) continue;
    const mine = activeSid.has(wc.id) ? activeSid.get(wc.id) || "" : "";
    const c = cfg();
    const obj = Object.assign({}, payload, {
      cfg: { show: c.show, pos: c.pos },
    });
    if (mine) obj.mine = mine;
    const js =
      "window.__rateUpdate && window.__rateUpdate(" +
      JSON.stringify(obj).replace(/[\u2028\u2029]/g, (c2) => (c2 === "\u2028" ? "\\u2028" : "\\u2029")) +
      ")";
    wc.executeJavaScript(js, true).catch(() => {});
  }
}

function handleResult(payload) {
  if (payload && payload.sessions) pushAll(payload);
}

function queryViaChild(sids) {
  const exe = process.execPath; // ZCode.exe；ELECTRON_RUN_AS_NODE 下即 Node
  const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" });
  const child = spawn(exe, [QUERY_CLI, sids.join(",")], { windowsHide: true, env });
  let out = "";
  const killTimer = setTimeout(() => {
    try {
      child.kill();
    } catch (e) {}
  }, 10000);
  child.stdout.on("data", (d) => (out += d));
  child.on("error", (e) => {
    busy = false;
    LOG("child query failed:", e.message);
  });
  child.on("close", () => {
    clearTimeout(killTimer);
    busy = false;
    if (out.trim()) {
      try {
        handleResult(JSON.parse(out));
      } catch (e) {
        LOG("child query bad json:", out.slice(0, 120));
      }
    }
  });
}

function runQuery(sids) {
  busy = true;
  if (!inProcFailed) {
    try {
      const payload = queryInProc(sids);
      busy = false;
      handleResult(payload);
      return;
    } catch (e) {
      inProcFailed = true;
      LOG("in-proc sqlite unavailable, fallback to child:", e.message);
    }
  }
  queryViaChild(sids);
}

/* ---------- 触发式拉取 ---------- */
let retryTimer = null;
function scheduleQuery(ms) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(maybeQuery, ms);
}

function dbDir() {
  return path.join(app.getPath("home"), ".zcode", "cli", "db");
}
function dbStamp() {
  let m = 0;
  const dir = dbDir();
  for (const f of ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"]) {
    try {
      m = Math.max(m, fs.statSync(path.join(dir, f)).mtimeMs);
    } catch (e) {}
  }
  return m;
}

function maybeQuery() {
  if (busy) {
    scheduleQuery(300);
    return;
  }
  const wcs = webContents.getAllWebContents().filter((wc) => isWindowType(wc) && !wc.isDestroyed());
  if (!wcs.length) return;
  const wants = [];
  const push = (sid) => {
    if (sid && !wants.includes(sid)) wants.push(sid);
  };
  for (const wc of wcs) {
    if (activeSid.has(wc.id)) push(activeSid.get(wc.id) || "");
  }
  /* IPC 映射未覆盖（旧客户端/辅助窗口）时，从渲染端 overlay 报告的数组兜底。 */
  if (!wants.length) {
    const readJs =
      "(function(){var a=window.__rateWantSids;return JSON.stringify(a||[])})()";
    Promise.all(wcs.map((wc) => wc.executeJavaScript(readJs, true).catch(() => "[]")))
      .then((vals) => {
        for (const v of vals) {
          try {
            for (const sid of JSON.parse(v || "[]")) push(sid);
          } catch (e) {}
        }
        finishWants(wants);
      })
      .catch(() => {});
    return;
  }
  finishWants(wants);
}

function finishWants(wants) {
  if (!wants.length) return; // 无会话聚焦：零查询
  const key = wants.join(",");
  const st = dbStamp();
  if (key === lastWants && st && st === lastStamp) return; // 无新写入不查
  const wait = Math.max(300, cfg().min_interval_ms | 0 || 900);
  const now = Date.now();
  if (now - lastQueryAt < wait) {
    scheduleQuery(wait - (now - lastQueryAt) + 50);
    return;
  }
  lastWants = key;
  if (st) lastStamp = st;
  lastQueryAt = now;
  runQuery(wants);
}

/* ---------- db 目录监听：一有写入（去抖 300ms）即查；空闲仅心跳 ---------- */
let debounceTimer = null;
let dbWatcher = null;
function watchDb() {
  if (dbWatcher) return;
  try {
    dbWatcher = fs.watch(dbDir(), (ev, f) => {
      if (f && !/db\.sqlite/.test(f)) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(maybeQuery, 300);
    });
    dbWatcher.on("error", () => {
      LOG("db watcher error, re-arm in 5s");
      try {
        dbWatcher.close();
      } catch (e) {}
      dbWatcher = null;
      setTimeout(watchDb, 5000);
    });
    LOG("watching", dbDir());
  } catch (e) {
    LOG("fs.watch failed, retry in 5s:", e.message);
    setTimeout(watchDb, 5000);
  }
}

setInterval(() => {
  if (cfg().hot_reload === false) return;
  hotReloadIfChanged();
}, 2000);
setInterval(maybeQuery, Math.max(5000, cfg().heartbeat_ms | 0 || 15000));
watchDb();
maybeQuery();

const hook = (wc) => {
  if (!isWindowType(wc)) return;
  wc.on("did-finish-load", () => injectOverlay(wc));
  if (wc.isLoading()) return;
  injectOverlay(wc);
};
app.on("web-contents-created", (e, wc) => hook(wc));
for (const wc of webContents.getAllWebContents()) hook(wc);

LOG("rate-tb loader v2 active (in-proc sqlite first, fs.watch db, per-window mine via IPC, cfg show/pos pushed with data)");
