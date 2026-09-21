/*
 * 业务规则层：线材回潮准入与贴线复核
 * 不接触 DOM、不直接读写 localStorage，状态经由 repo 注入。
 * 所有动作返回类 HTTP 结果：{ ok, status, body, error }，
 * 冲突 409 且不写入；准入失败 422（批次只能留检）。
 */
(function (global) {
  "use strict";

  var MOISTURE_LIMIT = 12; // 含水率准入上限（%）
  var REINSPECT_DAYS = 7;  // 复检报告有效期（天）

  var STATUS = { PENDING: "待复核", PASTING: "贴线中", DONE: "贴线完成" };
  var BATCH_OK = "合格";
  var BATCH_HELD = "留检";

  function genId() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function parseDate(s) {
    var parts = String(s).split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function dayDiff(from, to) {
    return Math.round((parseDate(to) - parseDate(from)) / 86400000);
  }

  function trim(v) {
    return String(v == null ? "" : v).trim();
  }

  // 回潮准入：含水率 > 12% 或复检超过 7 天，一律只能留检
  function admission(batch, today) {
    var reasons = [];
    var age = dayDiff(batch.inspectDate, today);
    if (Number(batch.moisture) > MOISTURE_LIMIT) {
      reasons.push("含水率 " + batch.moisture + "% 高于 " + MOISTURE_LIMIT + "%");
    }
    if (age > REINSPECT_DAYS) {
      reasons.push("复检已过 " + age + " 天（上限 " + REINSPECT_DAYS + " 天）");
    }
    return { admissible: reasons.length === 0, held: reasons.length > 0, reasons: reasons, ageDays: age };
  }

  function ok(status, body, extra) {
    return Object.assign({ ok: true, status: status, body: body || {} }, extra || {});
  }

  function fail(status, code, message, extra) {
    return Object.assign({ ok: false, status: status, error: { code: code, message: message } }, extra || {});
  }

  function replayOf(result) {
    return Object.assign({}, result, { replayed: true });
  }

  function createService(repo, options) {
    options = options || {};
    var clock = options.clock || function () { return new Date(); };
    var today = function () { return clock().toISOString().slice(0, 10); };
    var nowText = function () { return clock().toLocaleString(); };

    var ledger = new Map();    // 领用幂等账：requestKey -> 首次结果
    var inflight = new Map();  // requestKey -> 在途 Promise（并发同请求复用）
    var reserved = new Map();  // batchId -> pieceId（并发跨件抢同一批次的同步占位）

    function stamp(piece, msg) {
      piece.logs.push(nowText() + " " + msg);
    }

    function activeHolder(state, batchId, exceptPieceId) {
      return state.pieces.find(function (p) {
        return p.id !== exceptPieceId && p.batchId === batchId && p.status !== STATUS.DONE;
      }) || null;
    }

    function syncBatchFlags(batch, day) {
      var adm = admission(batch, day);
      batch.held = adm.held;
      batch.holdReasons = adm.reasons;
      batch.admissionText = batch.held ? BATCH_HELD : BATCH_OK;
      return adm;
    }

    /* ---------- 建档 ---------- */
    function createPiece(input) {
      var base = trim(input && input.base);
      var theme = trim(input && input.theme);
      if (!base || !theme) {
        return Promise.resolve(fail(422, "INVALID", "胎体材质与纹样主题都必须填写"));
      }
      var state = repo.load();
      var seq = state.pieces.reduce(function (m, p) { return Math.max(m, p.seq || 0); }, 0) + 1;
      var piece = {
        id: genId(),
        seq: seq,
        code: "J-" + String(seq).padStart(3, "0"),
        base: base,
        theme: theme,
        batchId: null,
        progress: 0,
        status: STATUS.PENDING,
        blockReason: "",
        logs: [nowText() + " 建档，进入待复核"],
        versions: []
      };
      state.pieces.unshift(piece);
      repo.save(state);
      return Promise.resolve(ok(201, { piece: piece }));
    }

    /* ---------- 领料（回潮准入 + 占用冲突 + 幂等/并发）---------- */
    function issueBatch(req) {
      req = req || {};
      var key = req.requestId || ("issue:" + req.pieceId + ":" + req.batchId);

      var cached = ledger.get(key);
      if (cached) return Promise.resolve(replayOf(cached));       // 重复领用：沿用首次结果
      var flying = inflight.get(key);
      if (flying) return flying.then(replayOf);                  // 并发同请求：沿用首次结果

      var state = repo.load();
      var piece = state.pieces.find(function (p) { return p.id === req.pieceId; });
      if (!piece) return Promise.resolve(fail(404, "NO_PIECE", "作品不存在"));
      var batch = state.batches.find(function (b) { return b.id === req.batchId; });
      if (!batch) return Promise.resolve(fail(404, "NO_BATCH", "线材批次不存在"));

      if (piece.status === STATUS.DONE) {
        var done = fail(409, "PIECE_DONE", "「" + piece.code + "」贴线已完成，不能再领料");
        ledger.set(key, done);
        return Promise.resolve(done);
      }
      if (piece.batchId === batch.id) {
        var admSame = syncBatchFlags(batch, today());
        if (!admSame.admissible) {
          repo.save(state);
          var heldSame = fail(422, "BATCH_HELD",
            "批次 " + batch.code + " 只能留检：" + admSame.reasons.join("；") + "，请先复检或更正批次",
            { body: { batch: batch } });
          ledger.set(key, heldSame);
          return Promise.resolve(heldSame);
        }
        var same = ok(200, { piece: piece, batch: batch }, { notice: "该件已领此批次，沿用首次领用记录" });
        ledger.set(key, same);
        return Promise.resolve(same);
      }
      if (piece.batchId) {
        var other = fail(409, "PIECE_HAS_BATCH",
          "「" + piece.code + "」已领批次 " + batchCode(state, piece.batchId) + "，如需换批请用更正（冲突，未写入）");
        ledger.set(key, other);
        return Promise.resolve(other);
      }

      // 准入判定：不合格只能留检（不写领用，只刷新批次留检状态）
      var adm = syncBatchFlags(batch, today());
      if (!adm.admissible) {
        repo.save(state);
        var held = fail(422, "BATCH_HELD",
          "批次 " + batch.code + " 只能留检：" + adm.reasons.join("；"),
          { body: { batch: batch } });
        ledger.set(key, held);
        return Promise.resolve(held);
      }

      // 冲突判定：同一批次贴线未完成，不得发给第二件；并发时先到者占位
      var holder = activeHolder(state, batch.id, piece.id);
      var reservedBy = reserved.get(batch.id);
      if (holder || (reservedBy && reservedBy !== piece.id)) {
        var who = holder || state.pieces.find(function (p) { return p.id === reservedBy; });
        var busy = fail(409, "BATCH_BUSY",
          "批次 " + batch.code + " 正由「" + (who ? who.code : "?") + "」贴线且未完成，不能再领给第二件（未写入）",
          { body: { batch: batch, holderPieceId: who ? who.id : null } });
        ledger.set(key, busy);
        return Promise.resolve(busy);
      }
      reserved.set(batch.id, piece.id);

      var promise = new Promise(function (resolve) {
        setTimeout(resolve, 40 + Math.random() * 90); // 暴露并发窗口
      }).then(function () {
        var s2 = repo.load();
        var p2 = s2.pieces.find(function (p) { return p.id === piece.id; });
        var b2 = s2.batches.find(function (b) { return b.id === batch.id; });
        var lateHolder = activeHolder(s2, b2.id, p2.id);
        if (lateHolder) {
          return fail(409, "BATCH_BUSY",
            "批次 " + b2.code + " 已被「" + lateHolder.code + "」抢先领用，冲突未写入",
            { body: { batch: b2, holderPieceId: lateHolder.id } });
        }
        syncBatchFlags(b2, today());
        b2.holderId = p2.id;
        p2.batchId = b2.id;
        p2.progress = 0;
        p2.status = STATUS.PASTING;
        p2.blockReason = "";
        stamp(p2, "领用 " + b2.code + "（含水率 " + b2.moisture + "%，复检 " + b2.inspectDate + "），准入通过，开始贴线");
        repo.save(s2);
        return ok(201, { piece: p2, batch: b2 });
      }).catch(function () {
        return fail(500, "INTERNAL", "领用处理异常，未写入");
      }).then(function (result) {
        if (reserved.get(batch.id) === piece.id) reserved.delete(batch.id);
        ledger.set(key, result); // 无论成败，首次结果入账
        return result;
      });

      inflight.set(key, promise);
      promise.then(function () { inflight.delete(key); }, function () { inflight.delete(key); });
      return promise;
    }

    function batchCode(state, id) {
      var b = state.batches.find(function (x) { return x.id === id; });
      return b ? b.code : "?";
    }

    /* ---------- 贴线进度 ---------- */
    function setProgress(pieceId, value) {
      var state = repo.load();
      var piece = state.pieces.find(function (p) { return p.id === pieceId; });
      if (!piece) return Promise.resolve(fail(404, "NO_PIECE", "作品不存在"));
      if (piece.status !== STATUS.PASTING) {
        return Promise.resolve(fail(422, "NOT_PASTING", "「" + piece.code + "」当前为「" + piece.status + "」，不能更新贴线进度"));
      }
      var n = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
      piece.progress = n;
      if (n >= 100) {
        var batch = state.batches.find(function (b) { return b.id === piece.batchId; });
        if (batch) batch.holderId = null; // 贴线完成，批次释放，可再领给下一件
        piece.status = STATUS.DONE;
        piece.blockReason = "";
        stamp(piece, "贴线完成，批次 " + (batch ? batch.code : "") + " 已释放");
      }
      repo.save(state);
      return Promise.resolve(ok(200, { piece: piece }));
    }

    /* ---------- 待复核件重新复核 ---------- */
    function reviewPiece(pieceId) {
      var state = repo.load();
      var piece = state.pieces.find(function (p) { return p.id === pieceId; });
      if (!piece) return Promise.resolve(fail(404, "NO_PIECE", "作品不存在"));
      if (piece.status !== STATUS.PENDING) {
        return Promise.resolve(fail(422, "NOT_PENDING", "「" + piece.code + "」不在待复核队列"));
      }
      if (!piece.batchId) {
        return Promise.resolve(fail(422, "NO_BATCH", "「" + piece.code + "」尚未领料，无法复核"));
      }
      var batch = state.batches.find(function (b) { return b.id === piece.batchId; });
      var adm = syncBatchFlags(batch, today());
      if (!adm.admissible) {
        piece.blockReason = "批次留检：" + adm.reasons.join("；");
        stamp(piece, "复核未过：" + piece.blockReason);
        repo.save(state);
        return Promise.resolve(fail(422, "BATCH_HELD",
          "批次 " + batch.code + " 只能留检：" + adm.reasons.join("；"), { body: { piece: piece, batch: batch } }));
      }
      piece.status = STATUS.PASTING;
      piece.blockReason = "";
      stamp(piece, "复核通过，恢复贴线（批次 " + batch.code + "）");
      repo.save(state);
      return Promise.resolve(ok(200, { piece: piece, batch: batch }));
    }

    /* ---------- 更正：旧进度失效、旧版留档、不进当前队列 ---------- */
    function correctPiece(pieceId, patch) {
      patch = patch || {};
      var state = repo.load();
      var piece = state.pieces.find(function (p) { return p.id === pieceId; });
      if (!piece) return Promise.resolve(fail(404, "NO_PIECE", "作品不存在"));

      var nextBase = trim(patch.base);
      var nextTheme = trim(patch.theme);
      var nextBatchId = patch.batchId === undefined ? piece.batchId : (patch.batchId || null);

      var changes = [];
      if (nextBase && nextBase !== piece.base) changes.push("胎体：" + piece.base + " → " + nextBase);
      if (nextTheme && nextTheme !== piece.theme) changes.push("纹样：" + piece.theme + " → " + nextTheme);
      var batchChanging = nextBatchId !== piece.batchId;
      if (batchChanging) {
        changes.push("已领批次：" + (piece.batchId ? batchCode(state, piece.batchId) : "未领料") +
          " → " + (nextBatchId ? batchCode(state, nextBatchId) : "未领料"));
      }
      if (!changes.length) return Promise.resolve(fail(400, "NO_CHANGE", "没有需要更正的内容"));

      // 更换批次先走准入与冲突校验：不通过则整体不写入
      var target = null;
      if (batchChanging && nextBatchId) {
        target = state.batches.find(function (b) { return b.id === nextBatchId; });
        if (!target) return Promise.resolve(fail(404, "NO_BATCH", "目标线材批次不存在"));
        var adm = admission(target, today());
        if (!adm.admissible) {
          return Promise.resolve(fail(422, "BATCH_HELD",
            "批次 " + target.code + " 只能留检：" + adm.reasons.join("；") + "，更正未写入"));
        }
        var holder = activeHolder(state, target.id, piece.id);
        var reservedBy = reserved.get(target.id);
        if (holder || (reservedBy && reservedBy !== piece.id)) {
          var who = holder || state.pieces.find(function (p) { return p.id === reservedBy; });
          return Promise.resolve(fail(409, "BATCH_BUSY",
            "批次 " + target.code + " 正由「" + (who ? who.code : "?") + "」贴线，更正未写入"));
        }
      }

      // 旧版留档：快照当前版本，嵌在 versions 中，看板只读取当前版本
      var snapshot = JSON.parse(JSON.stringify(piece));
      delete snapshot.versions;
      snapshot.archivedAt = nowText();
      snapshot.archiveReason = changes.join("；");
      piece.versions = piece.versions || [];
      piece.versions.unshift(snapshot);

      if (batchChanging) {
        var oldBatch = state.batches.find(function (b) { return b.id === piece.batchId; });
        if (oldBatch && oldBatch.holderId === piece.id) oldBatch.holderId = null;
        if (target) target.holderId = piece.id;
        piece.batchId = nextBatchId;
      }
      if (nextBase) piece.base = nextBase;
      if (nextTheme) piece.theme = nextTheme;

      piece.progress = 0;
      piece.status = STATUS.PENDING;
      piece.blockReason = "";
      stamp(piece, "更正（" + changes.join("；") + "），旧贴线进度立即失效，回到待复核；旧版已留档");
      repo.save(state);
      return Promise.resolve(ok(200, { piece: piece, archived: snapshot }));
    }

    /* ---------- 线材批次复检 ---------- */
    function reinspectBatch(batchId, moisture) {
      var state = repo.load();
      var batch = state.batches.find(function (b) { return b.id === batchId; });
      if (!batch) return Promise.resolve(fail(404, "NO_BATCH", "线材批次不存在"));
      var m = Number(moisture);
      if (!isFinite(m) || m < 0 || m > 100) {
        return Promise.resolve(fail(422, "INVALID", "含水率需为 0–100 之间的数值"));
      }
      batch.moisture = Math.round(m * 10) / 10;
      batch.inspectDate = today();
      var adm = syncBatchFlags(batch, today());
      batch.logs = batch.logs || [];
      batch.logs.push(nowText() + " 复检：含水率 " + batch.moisture + "% → " +
        (adm.admissible ? "合格可领" : "只能留检（" + adm.reasons.join("；") + "）"));
      repo.save(state);
      return Promise.resolve(ok(200, { batch: batch, admission: adm },
        adm.admissible ? {} : { notice: "复检后仍只能留检" }));
    }

    /* ---------- 刷新核对状态 ---------- */
    function refresh() {
      var state = repo.load();
      var day = today();
      state.batches.forEach(function (b) {
        syncBatchFlags(b, day);
        if (b.holderId) {
          var h = state.pieces.find(function (p) { return p.id === b.holderId; });
          if (!h || h.status === STATUS.DONE || h.batchId !== b.id) b.holderId = null;
        }
      });
      var blocked = [];
      state.pieces.forEach(function (p) {
        if (p.status !== STATUS.PASTING) return;
        var b = p.batchId && state.batches.find(function (x) { return x.id === p.batchId; });
        if (!b || b.held) {
          p.status = STATUS.PENDING;
          p.blockReason = !b ? "已领批次缺失" : "批次留检：" + b.holdReasons.join("；");
          stamp(p, "刷新核对：" + p.blockReason + "，退回待复核");
          blocked.push(p.code);
        }
      });
      repo.save(state);
      return Promise.resolve(ok(200, {
        today: day,
        pieces: state.pieces,
        batches: state.batches,
        heldBatches: state.batches.filter(function (b) { return b.held; }).map(function (b) { return b.code; }),
        blockedPieces: blocked
      }));
    }

    function snapshot() {
      return repo.load();
    }

    return {
      createPiece: createPiece,
      issueBatch: issueBatch,
      setProgress: setProgress,
      reviewPiece: reviewPiece,
      correctPiece: correctPiece,
      reinspectBatch: reinspectBatch,
      refresh: refresh,
      snapshot: snapshot
    };
  }

  global.LacquerRules = {
    MOISTURE_LIMIT: MOISTURE_LIMIT,
    REINSPECT_DAYS: REINSPECT_DAYS,
    STATUS: STATUS,
    BATCH_OK: BATCH_OK,
    BATCH_HELD: BATCH_HELD,
    admission: admission,
    dayDiff: dayDiff,
    createService: createService
  };
})(window);
