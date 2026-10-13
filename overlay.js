/* overlay.js — ZCode 速率工具栏渲染端（v2，自包含 IIFE）。
 * 位置（config.json pos）：
 *   left  —— 追加到 [data-composer-leading-actions] 末尾，
 *            即「完全访问」模式簇右侧（默认，与 Codex 参考布局一致）；
 *   right —— 插到 [data-composer-trailing-actions] 最前，
 *            即「用量/模型选择」簇左侧。
 * 显示项（config.json show）：首字(TTFT) / token/s / E2E(总耗时) 各自可开关，
 *   三项之间用中点 · 分隔；配置经主进程推送热生效（改 config.json 即可，无需重启）。
 * 数据：主进程 loader 经 window.__rateUpdate 推送（db.sqlite 只读快照）；
 *       E2E 只显示最近一个已完成回合的权威值（turn_usage.duration_ms），
 *       不实时跳动——新一轮回答完整落库后才更新。
 * 主题：颜色引用客户端 CSS 变量（--color-foreground*），深浅主题自动跟随。
 * 响应式：元素带 data-composer-collapse-priority=4，参与客户端自己的
 *       工具栏空间收纳（空间不足时先隐藏本指标，不打挤原生控件）。
 * 热更新：主进程 mtime 检测后重注入；代际守卫防旧实例打架。 */
(function () {
  if (window.__rateTbOverlay) return;
  window.__rateTbOverlay = true;
  var MY_GEN = (window.__rateTbGen = (window.__rateTbGen || 0) + 1);
  function stale() {
    return MY_GEN !== window.__rateTbGen;
  }

  try {
    document.querySelectorAll(".rate-tb-root").forEach(function (el) {
      el.remove();
    });
  } catch (e) {}

  /* ---------- 状态 ---------- */
  var data = null; // 最近一次推送 {ts, sessions:{...}, mine?, cfg?}
  var perComposer = new WeakMap(); // leading-actions el -> {node, sid, cfgKey}

  var CFG = { show: { ttft: true, tps: true, e2e: true }, pos: "left" };
  function cfgKey() {
    return JSON.stringify(CFG);
  }
  function applyCfg(c) {
    if (!c || typeof c !== "object") return;
    CFG = {
      show: {
        ttft: !(c.show && c.show.ttft === false),
        tps: !(c.show && c.show.tps === false),
        e2e: !(c.show && c.show.e2e === false),
      },
      pos: c.pos === "right" ? "right" : "left",
    };
  }

  function sidOfComposer(el) {
    for (var p = el; p && p !== document.body; p = p.parentElement) {
      if (p.hasAttribute && p.hasAttribute("data-session-id")) {
        var v = p.getAttribute("data-session-id") || "";
        return v && v !== "draft" ? v : "";
      }
    }
    return "";
  }

  function snapshotFor(sid) {
    if (!data || !data.sessions) return null;
    var s = sid && data.sessions[sid];
    if (s) return s;
    if (data.mine && data.sessions[data.mine]) return data.sessions[data.mine];
    return null;
  }

  /* ---------- 格式化 ---------- */
  function fmtMs(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
    if (ms < 1000) return Math.round(ms) + "ms";
    var s = ms / 1000;
    if (s < 60) return (Math.round(s * 10) / 10).toFixed(1) + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m" + String(Math.round(s % 60)).padStart(2, "0") + "s";
    return Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0") + "m";
  }
  function fmtTps(t) {
    if (t == null || !Number.isFinite(t) || t <= 0) return null;
    return (Math.round(t * 10) / 10).toFixed(1);
  }

  /* ---------- DOM ---------- */
  var CSS_INJECTED = false;
  function ensureCss() {
    if (CSS_INJECTED) return;
    CSS_INJECTED = true;
    var st = document.createElement("style");
    st.id = "rate-tb-style";
    st.textContent =
      ".rate-tb-root{display:inline-flex;align-items:center;gap:5px;min-width:0;" +
      "overflow:hidden;white-space:nowrap;height:28px;margin-left:6px;" +
      "font-size:11px;line-height:28px;-webkit-font-smoothing:antialiased;" +
      "color:var(--color-foreground-subtle,#8b8f98);cursor:default;" +
      "font-variant-numeric:tabular-nums;user-select:none;pointer-events:auto}" +
      ".rate-tb-root.rate-tb-right{margin-left:0;margin-right:6px}" +
      ".rate-tb-root[data-composer-compact=true]{display:none}" +
      ".rate-tb-root .rt-v{color:var(--color-foreground,#e8eaed);font-weight:500}" +
      ".rate-tb-root .rt-sep{opacity:.55;margin:0 1px}";
    document.head.appendChild(st);
  }

  function buildNode() {
    var root = document.createElement("div");
    root.className = "rate-tb-root" + (CFG.pos === "right" ? " rate-tb-right" : "");
    root.setAttribute("data-composer-collapse-priority", "4");
    root.setAttribute("aria-live", "off");
    var html = [];
    if (CFG.show.ttft) html.push('<span class="rt-ttft">首字 <span class="rt-v">–</span></span>');
    if (CFG.show.tps) html.push('<span class="rt-tps"><span class="rt-v">–</span> tok/s</span>');
    if (CFG.show.e2e) html.push('<span class="rt-e2e">E2E <span class="rt-v">–</span></span>');
    root.innerHTML = html.join('<span class="rt-sep">·</span>');
    return root;
  }

  /* ---------- 渲染 ---------- */
  function renderOne(el) {
    var st = perComposer.get(el);
    if (!st || !st.node || !st.node.isConnected) return;
    var snap = snapshotFor(st.sid);
    var ttft = snap ? snap.ttftMs : null;
    var tps = snap ? snap.tps : null;

    /* E2E 不跳动：只显示最近一个已完成回合的权威值（turn_usage.duration_ms），
     * 新一轮完整落库后随推送更新。运行态仅用于 tooltip 提示。 */
    var running = false;
    try {
      var scope = el.closest("form") || document;
      var stop = scope.querySelector('[data-testid="v4-stop"]');
      running = !!(stop && stop.getBoundingClientRect().width > 0);
    } catch (e) {}
    var e2eMs =
      snap && snap.turn && Number.isFinite(snap.turn.durationMs) && snap.turn.durationMs > 0
        ? snap.turn.durationMs
        : null;

    var ttftEl = st.node.querySelector(".rt-ttft .rt-v");
    var tpsEl = st.node.querySelector(".rt-tps .rt-v");
    var e2eEl = st.node.querySelector(".rt-e2e .rt-v");
    if (ttftEl) ttftEl.textContent = fmtMs(ttft) || "–";
    if (tpsEl) tpsEl.textContent = fmtTps(tps) || "–";
    if (e2eEl) e2eEl.textContent = fmtMs(e2eMs) || "–";

    var tip = [];
    if (snap && snap.last) {
      tip.push("最近请求：" + (snap.last.model || "未知模型"));
      tip.push("首字 TTFT：" + (fmtMs(snap.last.ttftMs) || "未上报"));
      tip.push(
        "生成段：" + (fmtMs(snap.last.genMs) || "–") + "，输出 " + (snap.last.outputTokens || 0) + " tokens",
      );
      tip.push("整请求耗时：" + (fmtMs(snap.last.durationMs) || "–"));
    }
    if (snap && snap.turn) {
      tip.push(
        "本轮：模型请求 " + (snap.turn.requests || 0) + " 次，工具 " + (snap.turn.tools || 0) + " 次，E2E " +
          (fmtMs(snap.turn.durationMs) || "–"),
      );
      tip.push(
        "本轮 token：输入 " + (snap.turn.inputTokens || 0) + " / 输出 " + (snap.turn.outputTokens || 0),
      );
    }
    tip.push(running ? "回合进行中…" : "空闲");
    st.node.title = tip.join("\n");
  }

  function renderAll() {
    document.querySelectorAll("[data-composer-leading-actions]").forEach(function (el) {
      if (el.offsetWidth <= 0 && el.offsetHeight <= 0) return;
      renderOne(el);
    });
  }

  /* ---------- 扫描/挂载 ---------- */
  function mountPoint(el) {
    if (CFG.pos !== "right") return { parent: el, before: null };
    var row = el.parentElement;
    var trailing =
      row && row.querySelector
        ? row.querySelector('[data-composer-trailing-actions]')
        : null;
    /* 结构变化（找不到 trailing 容器）时退回左侧位置。 */
    if (trailing) return { parent: trailing, before: trailing.firstChild };
    return { parent: el, before: null };
  }

  function scan() {
    var wants = [];
    var key = cfgKey();
    document.querySelectorAll("[data-composer-leading-actions]").forEach(function (el) {
      var sid = sidOfComposer(el);
      var st = perComposer.get(el);
      if (!sid) {
        /* 无会话归属（弹窗/草稿）不挂指标，已有的回收。 */
        if (st && st.node) st.node.remove();
        perComposer.delete(el);
        return;
      }
      if (wants.indexOf(sid) < 0) wants.push(sid);
      var needRebuild = !st || !st.node || !st.node.isConnected || st.cfgKey !== key;
      if (needRebuild) {
        ensureCss();
        if (st && st.node) st.node.remove();
        var node = buildNode();
        var mp = mountPoint(el);
        if (mp.before) mp.parent.insertBefore(node, mp.before);
        else mp.parent.appendChild(node);
        st = { node: node, sid: sid, cfgKey: key };
        perComposer.set(el, st);
        renderOne(el);
      } else if (st.sid !== sid) {
        st.sid = sid;
      }
    });
    window.__rateWantSids = wants.slice(0, 8);
  }

  window.__rateUpdate = function (d) {
    if (stale()) return;
    data = d;
    applyCfg(d && d.cfg);
    scan(); /* 配置变化（位置/显示项）即时重建 */
    renderAll();
  };

  setInterval(function () {
    if (stale()) return;
    scan();
    renderAll();
  }, 800);
  scan();
})();
