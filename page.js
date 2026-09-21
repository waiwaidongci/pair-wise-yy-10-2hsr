/*
 * 漆线雕 · 线材回潮准入与贴线复核台 —— 页面层
 * 只负责 DOM 渲染与交互；业务判定走 Rules，持久化走 Storage。
 */
(function () {
  "use strict";

  /* ---------- 装配 ---------- */
  var store = Storage.createStore();
  var service = Rules.createService(store, { clock: localToday });
  var requestLog = []; // 页面级请求流水（非业务数据，不持久化）

  function localToday() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function $(sel) { return document.querySelector(sel); }

  var state = store.getState();

  function batchMap() {
    var m = {};
    state.batches.forEach(function (b) { m[b.id] = b; });
    return m;
  }

  function batchName(id) {
    var b = batchMap()[id];
    return b ? b.batchNo : "（批次已不存在）";
  }

  /* ---------- 统一调用：记录流水 + Toast + 刷新 ---------- */
  function recordCall(action, res) {
    requestLog.unshift({
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      action: action,
      status: res.status,
      code: res.code,
      ok: res.ok,
      message: res.message
    });
    if (requestLog.length > 60) requestLog.length = 60;
    var cls = res.ok ? "ok2" : res.status === 409 ? "c409" : res.status === 422 ? "c422" : "c4xx";
    toast("[" + res.status + " " + res.code + "] " + res.message, cls);
  }

  function toast(text, cls) {
    var box = $("#toasts");
    var el = document.createElement("div");
    el.className = "toast " + (cls || "info");
    el.textContent = text;
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, 6500);
  }

  function refreshState() { state = store.getState(); render(); }

  /* ---------- 总览数字 ---------- */
  function renderSummary() {
    var pieces = state.pieces;
    var holding = state.batches.filter(function (b) { return !service.evaluate(b).admit; }).length;
    var busy = state.batches.filter(function (b) { return b.activeIssue; }).length;
    var stats = [
      { n: pieces.length, t: "当前工件版本" },
      { n: pieces.filter(function (p) { return p.stage === "待领料"; }).length, t: "待领料" },
      { n: pieces.filter(function (p) { return p.stage === "贴线中"; }).length, t: "贴线中（批次占用）" },
      { n: pieces.filter(function (p) { return p.stage === "待复核"; }).length, t: "待复核" },
      { n: holding + "/" + busy + "/" + state.batches.length, t: "留检/占用/批次总数" }
    ];
    $("#summary").innerHTML = stats.map(function (s) {
      return '<div class="stat"><b>' + s.n + '</b><span>' + s.t + '</span></div>';
    }).join("");
  }

  /* ---------- 当前队列看板 ---------- */
  function cardClass(stage) {
    return stage === "待复核" ? "review" : stage === "贴线完成" ? "done" : stage === "待领料" ? "wait" : "";
  }

  function renderBoard() {
    var html = service.STAGES.map(function (stage) {
      var cards = state.pieces.filter(function (p) { return p.stage === stage; });
      var body = cards.length ? cards.map(function (p) {
        var ev = p.batchId ? service.evaluate(batchMap()[p.batchId] || { moisture: 0, checkedAt: localToday() }) : null;
        var stageTag = p.stage === "待复核" ? '<span class="tag review">待复核</span>'
          : p.stage === "贴线完成" ? '<span class="tag ok">已释放</span>'
          : p.batchId ? '<span class="tag lock">批次占用中</span>' : '<span class="tag">未领料</span>';
        return '<article class="card ' + cardClass(stage) + '">' +
          '<b>《' + esc(p.theme) + '》</b>' + stageTag +
          '<div class="meta">v' + p.version + " · " + esc(p.base) + "<br>" +
          "批次：" + (p.batchId ? esc(batchName(p.batchId)) : "—") + "</div>" +
          (p.batchId ? '<div class="progress-track"><div class="progress-fill" style="width:' + p.progress + '%"></div></div>' +
            '<div class="meta">贴线进度 ' + p.progress + "%（含水率 " +
            (batchMap()[p.batchId] ? batchMap()[p.batchId].moisture : "?") + "%）</div>" : "") +
          '<div class="actions">' +
            (p.stage === "贴线中" ? '<button class="small" data-action="progress" data-id="' + p.id + '">登记进度</button>' : "") +
            (p.stage === "待复核" ? '<button class="small secondary" data-action="approve" data-id="' + p.id + '">复核通过</button>' : "") +
            (p.stage === "待领料" ? '<button class="small" data-action="quickIssue" data-id="' + p.id + '">填入领料</button>' : "") +
            '<button class="small violet" data-action="correct" data-id="' + p.id + '">更正</button>' +
          "</div>" +
          '<div class="meta" style="margin-top:5px">' + esc(p.logs[p.logs.length - 1]) + "</div>" +
        "</article>";
      }).join("") : '<div class="empty">暂无</div>';
      return '<section class="col"><h3><span>' + stage + '</span><span>' + cards.length + "</span></h3>" + body + "</section>";
    }).join("");
    $("#board").innerHTML = html;
  }

  /* ---------- 批次列表 ---------- */
  function renderBatches() {
    $("#batchList").innerHTML = state.batches.length ? state.batches.map(function (b) {
      var ev = service.evaluate(b);
      var holder = null;
      if (b.activeIssue) holder = state.pieces.find(function (p) { return p.id === b.activeIssue.pieceId; });
      var rowCls = !ev.admit ? "hold" : b.activeIssue ? "busy" : "free";
      var tags = !ev.admit
        ? '<span class="tag hold">只能留检</span>'
        : b.activeIssue
          ? '<span class="tag lock">贴线占用中</span>'
          : '<span class="tag ok">合格可领</span>';
      return '<div class="batch-row ' + rowCls + '">' +
        "<b>" + esc(b.batchNo) + "</b> " + tags +
        '<div class="meta">含水率 ' + b.moisture + "%（上限 12%）· 复检于 " + b.checkedAt +
          "（已 " + ev.age + " 天，上限 7 天）</div>" +
        (!ev.admit ? '<div class="meta" style="color:var(--red)">留检原因：' + esc(ev.reasons.join("；")) + "</div>" : "") +
        (b.activeIssue ? '<div class="meta">占用：' + (holder ? "《" + esc(holder.theme) + "》（" + esc(holder.base) + "）进度 " + holder.progress + "%" : "（工件已不存在）") + "</div>"
          : '<div class="meta">占用：无，贴线完成后可再领给第二件</div>') +
        '<div class="actions"><button class="small secondary" data-action="quickRecheck" data-id="' + b.id + '">填入复检</button></div>' +
      "</div>";
    }).join("") : '<div class="empty">暂无批次，请先建档</div>';
  }

  /* ---------- 留档 ---------- */
  function renderArchive() {
    $("#archiveList").innerHTML = state.archive.length ? state.archive.map(function (p) {
      return '<article class="card" style="opacity:0.85">' +
        '<b>《' + esc(p.theme) + '》</b> <span class="tag archived">v' + p.version + " 已留档 · 不进队列</span>" +
        '<div class="meta">' + esc(p.base) + " · 旧批次：" + esc(batchName(p.batchId)) +
          "<br>失效时贴线进度（冻结）：" + p.progress + "%<br>" +
          "更正内容：" + esc(p.archivedReason || "—") + "<br>留档时间：" + esc(p.archivedAt || "—") + "</div>" +
        "</article>";
    }).join("") : '<div class="empty">暂无旧版留档；对胎体、纹样或已领批次做更正后，旧版会在此留档</div>';
  }

  /* ---------- 请求流水 ---------- */
  function renderLog() {
    $("#requestLog").innerHTML = requestLog.length ? requestLog.map(function (r) {
      return '<div class="' + (r.ok ? "req-ok" : "req-fail") + '">' +
        r.time + ' <b>[' + r.status + " " + r.code + "]</b> " + esc(r.action) + " — " + esc(r.message) + "</div>";
    }).join("") : '<div class="empty">尚未发生请求</div>';
  }

  /* ---------- 表单下拉填充（保留已选项） ---------- */
  function fillSelect(sel, options, keep) {
    var cur = keep && sel.value;
    sel.innerHTML = options;
    if (cur && Array.prototype.some.call(sel.options, function (o) { return o.value === cur; })) {
      sel.value = cur;
    }
  }

  function renderSelects() {
    fillSelect($('#issueForm select[name="pieceId"]'), state.pieces.map(function (p) {
      return '<option value="' + p.id + '">《' + esc(p.theme) + '》（' + esc(p.base) + '）· ' +
        p.stage + (p.batchId ? " · 已领" + esc(batchName(p.batchId)) : "") + "</option>";
    }).join(""), true);

    var batchOpts = state.batches.map(function (b) {
      var ev = service.evaluate(b);
      var suffix = !ev.admit ? "｜留检：" + ev.reasons.join("；")
        : b.activeIssue ? "｜占用中（409）" : "｜合格可领";
      return '<option value="' + b.id + '">' + esc(b.batchNo) + "｜含水率 " + b.moisture + "%｜复检 " + b.checkedAt + suffix + "</option>";
    }).join("");
    fillSelect($('#issueForm select[name="batchId"]'), batchOpts, true);
    fillSelect($('#recheckForm select[name="batchId"]'), batchOpts, true);
  }

  function render() {
    renderSummary();
    renderBoard();
    renderBatches();
    renderArchive();
    renderSelects();
    renderLog();
    $("#clock").textContent = "今日 " + localToday();
  }

  /* ---------- 表单：工件建档 ---------- */
  $("#pieceForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var d = new FormData(e.currentTarget);
    var res = service.createPiece({ base: d.get("base"), theme: d.get("theme") });
    recordCall("工件建档", res);
    if (res.ok) e.currentTarget.reset();
    refreshState();
  });

  /* ---------- 表单：批次建档 ---------- */
  $("#batchForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.currentTarget;
    var d = new FormData(f);
    var res = service.createBatch({
      batchNo: d.get("batchNo"),
      moisture: d.get("moisture"),
      checkedAt: d.get("checkedAt")
    });
    recordCall("批次建档", res);
    if (res.ok) {
      f.querySelector('[name="batchNo"]').value = "";
      f.querySelector('[name="moisture"]').value = "10.5";
      f.querySelector('[name="checkedAt"]').value = localToday();
    }
    refreshState();
  });

  /* ---------- 表单：领料 ---------- */
  function doIssue(action) {
    var pieceId = $('#issueForm select[name="pieceId"]').value;
    var batchId = $('#issueForm select[name="batchId"]').value;
    if (!pieceId || !batchId) { toast("请先选择工件与批次", "c4xx"); return; }
    Promise.resolve(service.issue({ pieceId: pieceId, batchId: batchId })).then(function (res) {
      recordCall(action, res);
      refreshState();
    });
  }

  $("#issueForm").addEventListener("submit", function (e) {
    e.preventDefault();
    doIssue("领料");
  });

  /* 并发双发：两个请求共享同一在途结果，返回对象也完全相同 */
  $("#issueConcurrentBtn").addEventListener("click", function () {
    var pieceId = $('#issueForm select[name="pieceId"]').value;
    var batchId = $('#issueForm select[name="batchId"]').value;
    if (!pieceId || !batchId) { toast("请先选择工件与批次", "c4xx"); return; }
    var input = { pieceId: pieceId, batchId: batchId };
    Promise.all([service.issue(input), service.issue(input)]).then(function (rs) {
      recordCall("并发领料·第 1 次", rs[0]);
      var second = JSON.parse(JSON.stringify(rs[1]));
      second.message = "并发第 2 次沿用首次结果（同一在途请求，未重复判定、未重复写入）：" + rs[1].message;
      recordCall("并发领料·第 2 次", second);
      refreshState();
    });
  });

  /* ---------- 表单：复检 ---------- */
  $("#recheckForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.currentTarget;
    var d = new FormData(f);
    var res = service.recheck({
      batchId: d.get("batchId"),
      moisture: d.get("moisture"),
      checkedAt: d.get("checkedAt")
    });
    recordCall("线材复检", res);
    if (res.ok) f.querySelector('[name="moisture"]').value = "";
    refreshState();
  });

  /* ---------- 看板事件委托 ---------- */
  var activePieceId = null;

  $("#board").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-action]");
    if (!btn) return;
    var id = btn.dataset.id;
    var p = store.getState().pieces.find(function (x) { return x.id === id; });
    if (!p) return;

    if (btn.dataset.action === "progress") {
      activePieceId = id;
      $("#progressTitle").textContent = "贴线进度 · 《" + p.theme + "》";
      $("#progressInfo").innerHTML = "v" + p.version + " · " + esc(p.base) + " · 批次 " + esc(batchName(p.batchId)) +
        "<br>当前进度 " + p.progress + "%。填 100% 即贴线完成，批次占用释放。";
      $("#progressInput").value = Math.min(100, p.progress + 10);
      $("#progressDialog").showModal();
    }

    if (btn.dataset.action === "approve") {
      var res = service.approve({ pieceId: id });
      recordCall("复核通过", res);
      refreshState();
    }

    if (btn.dataset.action === "quickIssue") {
      $('#issueForm select[name="pieceId"]').value = id;
      toast("已把该工件填入领料单，请选择批次后提交", "info");
    }

    if (btn.dataset.action === "correct") {
      openCorrect(p);
    }
  });

  $("#progressSave").addEventListener("click", function () {
    var res = service.setProgress({ pieceId: activePieceId, progress: $("#progressInput").value });
    recordCall("贴线进度", res);
    $("#progressDialog").close();
    refreshState();
  });
  $("#progressClose").addEventListener("click", function () { $("#progressDialog").close(); });

  /* ---------- 更正弹窗 ---------- */
  function openCorrect(p) {
    activePieceId = p.id;
    $("#correctInfo").innerHTML = "v" + p.version + " · 《" + esc(p.theme) + "》（" + esc(p.base) + "）<br>" +
      "当前批次：" + (p.batchId ? esc(batchName(p.batchId)) : "无") + " · 当前进度 " + p.progress + "%（更正后清零失效）";
    $("#correctBase").value = p.base;
    $("#correctTheme").value = p.theme;

    var opts = '<option value="">无（退回未领料，仍需重新领发）</option>';
    state.batches.forEach(function (b) {
      var ev = service.evaluate(b);
      var note = !ev.admit ? "｜留检（换领将被拦）" : b.activeIssue && b.activeIssue.pieceId !== p.id ? "｜占用中（换领 409）"
        : b.activeIssue && b.activeIssue.pieceId === p.id ? "｜当前已领" : "｜合格可领";
      opts += '<option value="' + b.id + '"' + (b.id === p.batchId ? " selected" : "") + ">" +
        esc(b.batchNo) + note + "</option>";
    });
    $("#correctBatch").innerHTML = opts;
    $("#correctDialog").showModal();
  }

  $("#correctSave").addEventListener("click", function () {
    var res = service.correct({
      pieceId: activePieceId,
      base: $("#correctBase").value,
      theme: $("#correctTheme").value,
      batchId: $("#correctBatch").value
    });
    recordCall("胎体/纹样/批次更正", res);
    if (res.ok) $("#correctDialog").close();
    refreshState();
  });
  $("#correctClose").addEventListener("click", function () { $("#correctDialog").close(); });

  /* ---------- 批次列表事件（快速填入复检） ---------- */
  $("#batchList").addEventListener("click", function (e) {
    var btn = e.target.closest('button[data-action="quickRecheck"]');
    if (!btn) return;
    $('#recheckForm select[name="batchId"]').value = btn.dataset.id;
    var b = store.getState().batches.find(function (x) { return x.id === btn.dataset.id; });
    $('#recheckForm input[name="moisture"]').value = b ? b.moisture : "";
    $("#recheckForm").scrollIntoView({ behavior: "smooth", block: "center" });
    toast("已填入复检单，修改含水率/日期后提交", "info");
  });

  /* ---------- 刷新核对状态 ---------- */
  $("#refreshBtn").addEventListener("click", function () {
    var holding = state.batches.filter(function (b) { return !service.evaluate(b).admit; }).length;
    var busy = state.batches.filter(function (b) {
      return b.activeIssue && !state.pieces.some(function (p) { return p.id === b.activeIssue.pieceId && p.status === "current"; });
    }).length;
    refreshState();
    var message = "已按今日（" + localToday() + "）重新核对：留检批次 " + holding +
      " 个，贴线占用批次 " + state.batches.filter(function (b) { return b.activeIssue; }).length + " 个，待复核 " +
      state.pieces.filter(function (p) { return p.stage === "待复核"; }).length + " 件";
    requestLog.unshift({
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      action: "刷新核对", status: 0, code: "REFRESH", ok: true, message: message
    });
    toast(message, "info");
    renderLog();
  });

  /* ---------- 导出 / 重置 ---------- */
  $("#exportBtn").addEventListener("click", function () {
    var blob = new Blob([store.exportJSON()], { type: "application/json" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "lacquer-thread-station.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  $("#resetBtn").addEventListener("click", function () {
    if (!confirm("确定清除本地数据并恢复演示种子？")) return;
    store.reset();
    requestLog = [];
    refreshState();
    toast("已恢复演示数据", "info");
  });

  /* ---------- 初始化 ---------- */
  $("#batchForm input[name='checkedAt']").value = localToday();
  $("#recheckForm input[name='checkedAt']").value = localToday();
  render();
})();
