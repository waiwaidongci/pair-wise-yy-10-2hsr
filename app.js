/*
 * 页面层：建档 / 领料 / 复检 / 刷新核对，看板与留档渲染。
 * 只负责表单、事件和展示；准入、冲突、留档规则全部走 LacquerRules 服务。
 */
(function () {
  "use strict";

  var R = window.LacquerRules;
  var store = window.LacquerStorage;
  var service = R.createService(store);

  var state = store.load();
  var correctId = null;

  var $ = function (sel) { return document.querySelector(sel); };

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toast(result) {
    var box = $("#toast");
    box.className = "toast show " + (result.ok ? "ok" : result.status === 409 ? "conflict" : "fail");
    var tag = result.ok ? "HTTP " + result.status : "HTTP " + result.status;
    box.textContent = tag + " · " + (result.ok
      ? (result.notice || (result.error && result.error.message) || "操作成功")
      : result.error.message) + (result.replayed ? "（沿用首次结果）" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { box.className = "toast"; }, 4200);
  }

  function settle(promise) {
    return promise.then(function (r) {
      state = store.load();
      render();
      toast(r);
      return r;
    });
  }

  /* ---------- 下拉选项 ---------- */
  function batchOptions(selectedId, mode) {
    var opts = [];
    if (mode === "correct") {
      opts.push('<option value="__keep__">保持当前已领批次（仅更正胎体/纹样）</option>');
      opts.push('<option value="__none__">卸下批次（回到未领料）</option>');
    } else {
      opts.push('<option value="">— 请选择批次 —</option>');
    }
    state.batches.forEach(function (b) {
      var label = b.code + "（含水率 " + b.moisture + "%，复检 " + b.inspectDate + (b.held ? "，留检" : "，合格") + "）";
      opts.push('<option value="' + esc(b.id) + '"' + (b.id === selectedId ? " selected" : "") + ">" + esc(label) + "</option>");
    });
    return opts.join("");
  }

  function pieceOptions() {
    return state.pieces
      .filter(function (p) { return p.status !== R.STATUS.DONE; })
      .map(function (p) {
        return '<option value="' + esc(p.id) + '">' + esc(p.code + " · " + p.theme + " · " + p.base +
          " · " + p.status + (p.batchId ? "" : "（未领料）")) + "</option>";
      }).join("");
  }

  /* ---------- 看板 ---------- */
  function renderBoard() {
    var columns = [R.STATUS.PENDING, R.STATUS.PASTING, R.STATUS.DONE];
    $("#board").innerHTML = columns.map(function (col) {
      var list = state.pieces.filter(function (p) { return p.status === col; });
      var cards = list.map(function (p) {
        var b = p.batchId && state.batches.find(function (x) { return x.id === p.batchId; });
        var actions = "";
        if (p.status === R.STATUS.PASTING) {
          actions =
            '<button data-act="progress" data-id="' + p.id + '" class="warn">更新贴线进度</button>' +
            '<button data-act="done" data-id="' + p.id + '">标记贴线完成</button>';
        } else if (p.status === R.STATUS.PENDING) {
          actions =
            (b ? '<button data-act="review" data-id="' + p.id + '">复核通过/恢复贴线</button>' : "") +
            '<button data-act="correct" data-id="' + p.id + '" class="violet">更正</button>';
        }
        return '<article class="item ' + (p.status === R.STATUS.PENDING && p.blockReason ? "blocked" : "") + '">' +
          '<b>' + esc(p.code + " · " + p.theme) + '</b>' +
          '<div class="meta">胎体：' + esc(p.base) + "<br>线材批次：" + esc(b ? b.code : "未领料") +
          (b && b.held ? " <span class='tag held'>留检</span>" : "") + "<br>" +
          '贴线进度：' + p.progress + "%</div>" +
          '<div class="bar"><i style="width:' + p.progress + '%"></i></div>' +
          (p.blockReason ? '<div class="block-reason">⚠ ' + esc(p.blockReason) + "</div>" : "") +
          '<div class="meta log">最新：' + esc(p.logs[p.logs.length - 1]) + "</div>" +
          '<div class="actions">' + actions +
          '<button data-act="correct" data-id="' + p.id + '" class="violet">更正</button>' +
          '<button data-act="history" data-id="' + p.id + '" class="secondary">留档(' + p.versions.length + ")</button>" +
          "</div></article>";
      }).join("");
      return '<section class="col"><h3><span>' + col + "</span><span>" + list.length + "</span></h3>" +
        (cards || '<div class="empty">暂无作品</div>') + "</section>";
    }).join("");
  }

  function renderBatches() {
    $("#batchList").innerHTML = state.batches.map(function (b) {
      var holder = b.holderId && state.pieces.find(function (p) { return p.id === b.holderId; });
      return '<div class="batch ' + (b.held ? "held" : "ok") + '">' +
        "<b>" + esc(b.code) + "</b> <span class=\"tag " + (b.held ? "held" : "ok") + "\">" +
        esc(b.held ? R.BATCH_HELD : R.BATCH_OK) + "</span>" +
        '<div class="meta">含水率 ' + esc(b.moisture) + "% · 复检 " + esc(b.inspectDate) + "<br>" +
        (holder ? "占用：" + esc(holder.code + " " + holder.theme) + (holder.status === R.STATUS.DONE ? "（完成待释放）" : "（贴线中）") : "空闲可领") +
        (b.holdReasons && b.holdReasons.length ? "<br>原因：" + esc(b.holdReasons.join("；")) : "") + "</div>" +
        '<div class="actions"><button data-act="reinspect" data-id="' + b.id + '" class="warn">复检登记</button></div>' +
        "</div>";
    }).join("");
  }

  function renderArchives() {
    var rows = [];
    state.pieces.forEach(function (p) {
      p.versions.forEach(function (v, idx) {
        rows.push({ piece: p, v: v, idx: idx });
      });
    });
    $("#archiveList").innerHTML = rows.length ? rows.map(function (r) {
      var b = r.v.batchId && state.batches.find(function (x) { return x.id === r.v.batchId; });
      return '<div class="item archived">' +
        "<b>" + esc(r.piece.code + " · 旧版 " + esc(r.v.theme)) + "</b>" +
        '<div class="meta">胎体：' + esc(r.v.base) + " · 批次：" + esc(b ? b.code : "未领料") +
        " · 进度：" + esc(r.v.progress) + "%<br>留档时间：" + esc(r.v.archivedAt) + "<br>原因：" + esc(r.v.archiveReason) +
        '<br><span class="tag held">不进当前队列</span></div></div>';
    }).join("") : '<div class="empty">暂无旧版留档</div>';
  }

  function renderForms() {
    $("#issuePiece").innerHTML = pieceOptions();
    $("#issueBatch").innerHTML = batchOptions();
    var p2 = state.pieces.filter(function (p) { return p.status !== R.STATUS.DONE && !p.batchId; });
    var pair = $("#concurrentPair");
    if (pair) {
      var ids = p2.slice(0, 2);
      pair.disabled = ids.length < 2;
      pair.title = ids.length < 2 ? "需要至少两件未领料作品" : "";
      pair.textContent = ids.length >= 2
        ? "并发演示：同批同时领给 " + ids[0].code + " 与 " + ids[1].code
        : "并发演示（需两件未领料作品）";
      pair.dataset.a = ids[0] ? ids[0].id : "";
      pair.dataset.b = ids[1] ? ids[1].id : "";
    }
  }

  function render() {
    renderForms();
    renderBoard();
    renderBatches();
    renderArchives();
  }

  /* ---------- 事件：建档 ---------- */
  $("#createForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    settle(service.createPiece({ base: f.base.value, theme: f.theme.value })).then(function (r) {
      if (r.ok) f.reset();
    });
  });

  /* ---------- 事件：领料 ---------- */
  $("#issueForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    if (!f.pieceId.value || !f.batchId.value) {
      toast({ ok: false, status: 422, error: { message: "请选择作品与线材批次" } });
      return;
    }
    settle(service.issueBatch({
      pieceId: f.pieceId.value,
      batchId: f.batchId.value,
      requestId: "ui:" + f.pieceId.value + ":" + f.batchId.value
    }));
  });

  /* 并发同请求：重复领用沿用首次结果 */
  $("#repeatIssue").addEventListener("click", function () {
    var f = $("#issueForm");
    if (!f.pieceId.value || !f.batchId.value) {
      toast({ ok: false, status: 422, error: { message: "请先选择作品与批次" } });
      return;
    }
    var req = { pieceId: f.pieceId.value, batchId: f.batchId.value, requestId: "repeat:" + Date.now() };
    settle(Promise.all([
      service.issueBatch(req),
      service.issueBatch(req) // 完全相同的请求并发两次
    ]).then(function (rs) {
      var second = rs[1];
      second._note = "第二次请求" + (second.replayed ? "沿用首次结果" : "");
      return rs[0];
    }));
  });

  /* 并发跨件：同一批次同时领给两件，先到先得，后者 409 */
  $("#concurrentPair").addEventListener("click", function (e) {
    var btn = e.currentTarget;
    var batchId = $("#issueBatch").value || state.batches[0].id;
    var a = btn.dataset.a, b = btn.dataset.b;
    if (!a || !b) return;
    var p1 = service.issueBatch({ pieceId: a, batchId: batchId, requestId: "race:" + a + ":" + batchId });
    var p2 = service.issueBatch({ pieceId: b, batchId: batchId, requestId: "race:" + b + ":" + batchId });
    settle(Promise.all([p1, p2]).then(function (rs) {
      var loser = rs.find(function (r) { return !r.ok; });
      var winner = rs.find(function (r) { return r.ok; });
      var msg = loser
        ? "一件成功（" + (winner && winner.status) + "），另一件 " + loser.status + "：" + loser.error.message
        : "两件均成功";
      return { ok: !!winner, status: loser ? loser.status : 200, error: { message: msg }, notice: msg };
    }));
  });

  /* ---------- 看板动作（事件委托）---------- */
  $("#board").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-act]");
    if (!btn) return;
    var id = btn.dataset.id, act = btn.dataset.act;
    if (act === "done") settle(service.setProgress(id, 100));
    if (act === "progress") {
      var cur = state.pieces.find(function (p) { return p.id === id; });
      var v = prompt("更新贴线进度（0–100，100 即完成并释放批次）", cur ? cur.progress : 0);
      if (v != null) settle(service.setProgress(id, Number(v)));
    }
    if (act === "review") settle(service.reviewPiece(id));
    if (act === "correct") openCorrect(id);
    if (act === "history") openHistory(id);
  });

  $("#batchList").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-act='reinspect']");
    if (!btn) return;
    var b = state.batches.find(function (x) { return x.id === btn.dataset.id; });
    var v = prompt("复检登记：输入最新含水率（%）。复检日期记为今天；> " + R.MOISTURE_LIMIT + "% 或复检超 " + R.REINSPECT_DAYS + " 天只能留检。", b.moisture);
    if (v != null && v.trim() !== "") settle(service.reinspectBatch(b.id, Number(v)));
  });

  /* ---------- 更正弹窗 ---------- */
  function openCorrect(id) {
    correctId = id;
    var p = state.pieces.find(function (x) { return x.id === id; });
    $("#correctBase").value = p.base;
    $("#correctTheme").value = p.theme;
    $("#correctBatch").innerHTML = batchOptions(p.batchId, "correct");
    $("#correctBatch").value = p.batchId || "__none__";
    $("#correctWarn").textContent = "提交后旧贴线进度立即失效、作品回到待复核；当前版本快照留档，旧版不出现在看板队列。";
    $("#correctDialog").showModal();
  }

  $("#correctSubmit").addEventListener("click", function () {
    var rawBatch = $("#correctBatch").value;
    var batchPatch = rawBatch === "__keep__" ? undefined : (rawBatch === "__none__" ? null : rawBatch);
    settle(service.correctPiece(correctId, {
      base: $("#correctBase").value,
      theme: $("#correctTheme").value,
      batchId: batchPatch
    })).then(function (r) { if (r.ok) $("#correctDialog").close(); });
  });
  $("#correctCancel").addEventListener("click", function () { $("#correctDialog").close(); });

  /* ---------- 留档弹窗 ---------- */
  function openHistory(id) {
    var p = state.pieces.find(function (x) { return x.id === id; });
    $("#historyTitle").textContent = p.code + " · " + p.theme + " — 旧版留档";
    $("#historyContent").innerHTML = p.versions.length ? p.versions.map(function (v) {
      var b = v.batchId && state.batches.find(function (x) { return x.id === v.batchId; });
      return '<div class="arch-card"><b>旧版：' + esc(v.theme) + "（" + esc(v.base) + "）</b>" +
        '<div class="meta">批次：' + esc(b ? b.code : "未领料") + " · 进度：" + esc(v.progress) + "%" +
        " · 状态：" + esc(v.status) + "<br>留档时间：" + esc(v.archivedAt) + "<br>原因：" + esc(v.archiveReason) +
        "<br>日志：" + esc(v.logs.join(" / ")) + "</div></div>";
    }).join("") : '<div class="empty">该件暂无留档版本</div>';
    $("#historyDialog").showModal();
  }
  $("#historyClose").addEventListener("click", function () { $("#historyDialog").close(); });

  /* ---------- 刷新 / 重置 ---------- */
  $("#refreshBtn").addEventListener("click", function () {
    settle(service.refresh()).then(function (r) {
      if (r.ok && !r.body.blockedPieces.length && !r.body.heldBatches.length) {
        toast({ ok: true, status: 200, notice: "核对完成：无留检批次、无退回件" });
      }
    });
  });

  $("#resetBtn").addEventListener("click", function () {
    if (confirm("清空本地数据并恢复演示种子？")) {
      state = store.reset();
      render();
      toast({ ok: true, status: 200, notice: "已恢复演示数据" });
    }
  });

  /* ---------- 启动即刷新核对 ---------- */
  service.refresh().then(function () {
    state = store.load();
    render();
  });
})();
