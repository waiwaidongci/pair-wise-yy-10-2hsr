/*
 * 漆线雕 · 线材回潮准入与贴线复核台 —— 业务规则层
 * 纯领域逻辑：不碰 DOM、不直接持久化；所有写操作经 store.transact 提交，
 * 返回类 HTTP 结果 { ok, status, code, message, data }，非 2xx 不落盘。
 */
(function (global) {
  "use strict";

  var MOISTURE_LIMIT = 12; // 含水率上限（%），高于 12% 只能留检
  var RECHECK_DAYS = 7;    // 复检有效期（天），超过 7 天只能留检
  var DAY_MS = 86400000;

  var STAGES = ["待领料", "贴线中", "贴线完成", "待复核"];

  function uid(prefix) {
    return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function stamp() {
    return new Date().toLocaleString("zh-CN", { hour12: false });
  }

  function R(status, code, message, data) {
    return { ok: status < 400, status: status, code: code, message: message, data: data || {} };
  }

  /* 两个日期字符串相差天数（to - from） */
  function dayDiff(from, to) {
    var a = new Date(from + "T00:00:00").getTime();
    var b = new Date(to + "T00:00:00").getTime();
    return Math.round((b - a) / DAY_MS);
  }

  function isValidDate(s) {
    return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + "T00:00:00").getTime());
  }

  function pieceLabel(p) {
    return "《" + p.theme + "》（" + p.base + "）v" + p.version;
  }

  /*
   * 准入判定（回潮准入闸）：
   * 含水率高于 12%，或距上次复检超过 7 天 → 只能留检，不得发料。
   */
  function evaluateBatch(batch, today) {
    var age = dayDiff(batch.checkedAt, today);
    var reasons = [];
    if (batch.moisture > MOISTURE_LIMIT) {
      reasons.push("含水率 " + batch.moisture + "% 高于上限 " + MOISTURE_LIMIT + "%");
    }
    if (age > RECHECK_DAYS) {
      reasons.push("距上次复检已 " + age + " 天，超过 " + RECHECK_DAYS + " 天上限");
    }
    return { admit: reasons.length === 0, age: age, reasons: reasons };
  }

  function createService(store, options) {
    options = options || {};
    var clock = options.clock || function () { return new Date().toISOString().slice(0, 10); };
    var inflight = Object.create(null); // 在途领用请求：并发时沿用首次结果

    function tx(fn) { return store.transact(fn); }

    function findPiece(d, id) { return d.pieces.find(function (p) { return p.id === id; }); }
    function findBatch(d, id) { return d.batches.find(function (b) { return b.id === id; }); }

    /* ---------- 建档：工件 ---------- */
    function createPiece(input) {
      return tx(function (d) {
        var base = (input.base || "").trim();
        var theme = (input.theme || "").trim();
        if (!base || !theme) return R(400, "BAD_INPUT", "胎体材质与纹样主题均为必填项");
        var p = {
          id: uid("p"),
          lineageId: uid("line"),
          version: 1,
          base: base,
          theme: theme,
          batchId: null,
          progress: 0,
          stage: "待领料",
          status: "current",
          createdAt: clock(),
          correctedFrom: null,
          logs: [stamp() + " 建档，等待领料"]
        };
        d.pieces.unshift(p);
        return R(201, "PIECE_CREATED", "已建档：" + pieceLabel(p), { pieceId: p.id });
      });
    }

    /* ---------- 建档：线材批次 ---------- */
    function createBatch(input) {
      return tx(function (d) {
        var batchNo = (input.batchNo || "").trim();
        var moisture = Number(input.moisture);
        var checkedAt = input.checkedAt || clock();
        if (!batchNo) return R(400, "BAD_INPUT", "批次号为必填项");
        if (d.batches.some(function (b) { return b.batchNo === batchNo; })) {
          return R(409, "BATCH_NO_EXISTS", "批次号 " + batchNo + " 已存在，冲突未写入");
        }
        if (isNaN(moisture) || moisture < 0 || moisture > 100) return R(400, "BAD_INPUT", "含水率须为 0–100 之间的数值");
        if (!isValidDate(checkedAt)) return R(400, "BAD_INPUT", "检测日期格式应为 YYYY-MM-DD");

        var b = {
          id: uid("b"),
          batchNo: batchNo,
          moisture: moisture,
          checkedAt: checkedAt,
          activeIssue: null, // { pieceId, issuedAt }：贴线未完成期间的占用
          logs: [stamp() + " 批次建档：含水率 " + moisture + "%，检测日期 " + checkedAt]
        };
        var ev = evaluateBatch(b, clock());
        b.logs.push(stamp() + " 准入判定：" + (ev.admit ? "合格，可发料" : "留检：" + ev.reasons.join("；")));
        d.batches.unshift(b);
        return R(201, "BATCH_CREATED",
          "批次 " + batchNo + " 已建档，准入判定：" + (ev.admit ? "合格" : "留检（" + ev.reasons.join("；") + "）"),
          { batchId: b.id, admitted: ev.admit });
      });
    }

    /* ---------- 领料（核心） ---------- */
    function applyIssue(d, input, today) {
      var p = findPiece(d, input.pieceId);
      if (!p || p.status !== "current") return R(404, "PIECE_NOT_FOUND", "工件不存在，或已是失效旧版");
      var b = findBatch(d, input.batchId);
      if (!b) return R(404, "BATCH_NOT_FOUND", "线材批次不存在");

      // 1) 重复领用：本件当前版本已绑该批 → 沿用首次领用结果
      if (p.batchId === b.id) {
        return R(200, "ISSUE_REPLAY",
          "重复领用沿用首次结果：" + b.batchNo + " 已领用于 " + pieceLabel(p) + "，不再重复发料",
          { pieceId: p.id, batchId: b.id, replayed: true, issuedAt: p.issuedAt || null });
      }

      // 2) 回潮准入闸：含水率超标 / 复检超期 → 只能留检
      var ev = evaluateBatch(b, today);
      if (!ev.admit) {
        return R(422, "HOLD_FOR_INSPECTION",
          "批次 " + b.batchNo + " 只能留检：" + ev.reasons.join("；") + "，请复检合格后再领",
          { batchId: b.id, reasons: ev.reasons });
      }

      // 3) 工件自身已领他批且贴线未完成
      if (p.batchId) {
        var own = findBatch(d, p.batchId);
        return R(409, "PIECE_ALREADY_ISSUED",
          pieceLabel(p) + " 已领用批次 " + (own ? own.batchNo : p.batchId) + "，贴线未完成前不得另领；本次冲突未写入",
          { pieceId: p.id, batchId: p.batchId });
      }

      // 4) 待复核版本先复核再领料
      if (p.stage === "待复核") {
        return R(409, "PENDING_REVIEW", pieceLabel(p) + " 处于待复核状态，请先通过复核再领料；本次冲突未写入", { pieceId: p.id });
      }

      // 5) 批次正贴线于另一件 → 409，且不写入
      if (b.activeIssue && b.activeIssue.pieceId !== p.id) {
        var holder = findPiece(d, b.activeIssue.pieceId);
        return R(409, "BATCH_IN_PROGRESS",
          "批次 " + b.batchNo + " 正贴线于 " + (holder ? pieceLabel(holder) : "另一件") +
          "（进度 " + (holder ? holder.progress : "?") + "%），贴线未完成前不得再领给第二件；本次冲突未写入",
          { batchId: b.id, holderId: b.activeIssue.pieceId });
      }

      // 6) 发料
      p.batchId = b.id;
      p.stage = "贴线中";
      p.progress = 0;
      p.issuedAt = stamp();
      p.logs.push(stamp() + " 领用 " + b.batchNo + "（含水率 " + b.moisture + "%，复检在 7 日内），进入贴线");
      b.activeIssue = { pieceId: p.id, issuedAt: today };
      b.logs.push(stamp() + " 发料 → " + pieceLabel(p));
      return R(201, "ISSUED", "已发料：" + b.batchNo + " → " + pieceLabel(p), { pieceId: p.id, batchId: b.id });
    }

    /*
     * 领用入口：同一 (工件, 批次) 的在途请求共享同一个 Promise，
     * 并发双击 / 重放均沿用首次结果；409/422 不落盘，事后可重新申请。
     */
    function issue(input) {
      var key = "issue:" + input.pieceId + ":" + input.batchId;
      if (inflight[key]) return inflight[key];
      var pending = Promise.resolve().then(function () {
        return tx(function (d) { return applyIssue(d, input, clock()); });
      });
      inflight[key] = pending;
      pending.then(function () { delete inflight[key]; }, function () { delete inflight[key]; });
      return pending;
    }

    /* ---------- 复检 ---------- */
    function recheck(input) {
      return tx(function (d) {
        var b = findBatch(d, input.batchId);
        if (!b) return R(404, "BATCH_NOT_FOUND", "线材批次不存在");
        var moisture = Number(input.moisture);
        var checkedAt = input.checkedAt || clock();
        if (isNaN(moisture) || moisture < 0 || moisture > 100) return R(400, "BAD_INPUT", "含水率须为 0–100 之间的数值");
        if (!isValidDate(checkedAt)) return R(400, "BAD_INPUT", "复检日期格式应为 YYYY-MM-DD");

        b.moisture = moisture;
        b.checkedAt = checkedAt;
        var ev = evaluateBatch(b, checkedAt);
        b.logs.push(stamp() + " 复检：含水率 " + moisture + "%，复检日期 " + checkedAt +
          "（" + (ev.admit ? "合格，解除留检" : "仍须留检：" + ev.reasons.join("；")) + "）");
        return R(200, ev.admit ? "RECHECK_PASS" : "RECHECK_HOLD",
          "批次 " + b.batchNo + (ev.admit ? " 复检合格，可领料" : " 复检后仍须留检：" + ev.reasons.join("；")),
          { batchId: b.id, admitted: ev.admit, reasons: ev.reasons });
      });
    }

    /* ---------- 贴线进度 ---------- */
    function setProgress(input) {
      return tx(function (d) {
        var p = findPiece(d, input.pieceId);
        if (!p || p.status !== "current") return R(404, "PIECE_NOT_FOUND", "工件不存在，或已是失效旧版");
        if (p.stage !== "贴线中") return R(409, "NOT_PASTING", pieceLabel(p) + " 当前为「" + p.stage + "」，不可登记贴线进度");
        var value = Math.max(0, Math.min(100, Math.floor(Number(input.progress))));
        if (isNaN(value)) return R(400, "BAD_INPUT", "贴线进度须为 0–100 的整数");

        p.progress = value;
        if (value < 100) {
          p.logs.push(stamp() + " 贴线进度更新为 " + value + "%");
          return R(200, "PROGRESS_SET", pieceLabel(p) + " 贴线进度 " + value + "%", { pieceId: p.id, progress: value });
        }

        // 贴线完成 → 释放批次占用，此后可领给第二件
        p.stage = "贴线完成";
        if (p.batchId) {
          var b = findBatch(d, p.batchId);
          if (b && b.activeIssue && b.activeIssue.pieceId === p.id) {
            b.activeIssue = null;
            b.logs.push(stamp() + " " + pieceLabel(p) + " 贴线完成，批次占用释放，可再领给第二件");
          }
        }
        p.logs.push(stamp() + " 贴线完成 100%，批次占用释放");
        return R(200, "PROGRESS_DONE", pieceLabel(p) + " 贴线完成，批次已释放，可领给第二件", { pieceId: p.id, progress: 100 });
      });
    }

    /* ---------- 更正：胎体 / 纹样 / 已领批次 ---------- */
    function correct(input) {
      return tx(function (d) {
        var p = findPiece(d, input.pieceId);
        if (!p || p.status !== "current") return R(404, "PIECE_NOT_FOUND", "工件不存在，或已是失效旧版");

        var base = input.base != null ? String(input.base).trim() : p.base;
        var theme = input.theme != null ? String(input.theme).trim() : p.theme;
        var newBatchId = input.batchId !== undefined ? (input.batchId || null) : p.batchId;
        if (!base || !theme) return R(400, "BAD_INPUT", "胎体材质与纹样主题不能为空");

        var changes = [];
        if (base !== p.base) changes.push("胎体：" + p.base + " → " + base);
        if (theme !== p.theme) changes.push("纹样：" + p.theme + " → " + theme);
        var oldBatch = findBatch(d, p.batchId);
        var newBatch = newBatchId ? findBatch(d, newBatchId) : null;
        if (newBatchId !== p.batchId) {
          changes.push("已领批次：" + (oldBatch ? oldBatch.batchNo : "无") + " → " + (newBatch ? newBatch.batchNo : "无"));
        }
        if (changes.length === 0) return R(400, "NO_CHANGE", "胎体、纹样、已领批次均无变化，无需更正");

        // 换新批次须重过准入与占用校验；任一不过整笔更正不写入，旧版保留
        if (newBatchId && newBatchId !== p.batchId) {
          if (!newBatch) return R(404, "BATCH_NOT_FOUND", "目标线材批次不存在，更正未写入，旧版保留");
          var ev = evaluateBatch(newBatch, clock());
          if (!ev.admit) {
            return R(422, "HOLD_FOR_INSPECTION",
              "目标批次 " + newBatch.batchNo + " 只能留检：" + ev.reasons.join("；") + "，更正未写入，旧版保留",
              { reasons: ev.reasons });
          }
          if (newBatch.activeIssue && newBatch.activeIssue.pieceId !== p.id) {
            var holder = findPiece(d, newBatch.activeIssue.pieceId);
            return R(409, "BATCH_IN_PROGRESS",
              "目标批次 " + newBatch.batchNo + " 正贴线于 " + (holder ? pieceLabel(holder) : "另一件") +
              "，不可换领；更正未写入，旧版保留", { holderId: newBatch.activeIssue.pieceId });
          }
        }

        var oldVersion = p.version;
        var reasonText = changes.join("；");

        // 1) 旧版冻结留档，退出当前队列
        var archived = JSON.parse(JSON.stringify(p));
        archived.status = "archived";
        archived.archivedAt = stamp();
        archived.archivedReason = reasonText;
        archived.logs.push(stamp() + " 旧版因更正立即失效（" + reasonText + "），留档备查，退出当前队列");
        d.archive.unshift(archived);

        // 2) 新当前版：贴线进度清零，回到待复核
        var np = {
          id: uid("p"),
          lineageId: p.lineageId,
          version: p.version + 1,
          base: base,
          theme: theme,
          batchId: null,
          progress: 0,
          stage: "待复核",
          status: "current",
          createdAt: clock(),
          correctedFrom: p.id,
          logs: [stamp() + " 由 v" + oldVersion + " 更正生成（" + reasonText + "）：旧贴线进度已失效，待复核"]
        };

        // 3) 批次占用随版本交接
        if (newBatchId && newBatchId !== p.batchId) {
          if (oldBatch && oldBatch.activeIssue && oldBatch.activeIssue.pieceId === p.id) {
            oldBatch.activeIssue = null;
            oldBatch.logs.push(stamp() + " " + pieceLabel(p) + " 更正换批，原批次占用释放");
          }
          newBatch.activeIssue = { pieceId: np.id, issuedAt: clock() };
          newBatch.logs.push(stamp() + " 更正换批发料 → " + pieceLabel(np));
          np.batchId = newBatchId;
        } else if (p.batchId) {
          // 仅改胎体/纹样：占用锁移交给新版本
          var same = findBatch(d, p.batchId);
          if (same && same.activeIssue && same.activeIssue.pieceId === p.id) {
            same.activeIssue = { pieceId: np.id, issuedAt: clock() };
            same.logs.push(stamp() + " 占用随更正移交至 " + pieceLabel(np));
          }
          np.batchId = p.batchId;
        }

        d.pieces[d.pieces.indexOf(p)] = np;
        return R(200, "CORRECTED",
          "更正完成：v" + oldVersion + " 已留档（不进当前队列），新版 v" + np.version + " 贴线进度清零，回到待复核",
          { oldId: p.id, newId: np.id, version: np.version });
      });
    }

    /* ---------- 复核通过 ---------- */
    function approve(input) {
      return tx(function (d) {
        var p = findPiece(d, input.pieceId);
        if (!p || p.status !== "current") return R(404, "PIECE_NOT_FOUND", "工件不存在，或已是失效旧版");
        if (p.stage !== "待复核") return R(409, "NOT_PENDING_REVIEW", pieceLabel(p) + " 当前为「" + p.stage + "」，无需复核");
        p.stage = p.batchId ? "贴线中" : "待领料";
        p.logs.push(stamp() + " 复核通过，进入「" + p.stage + "」");
        return R(200, "REVIEW_APPROVED", pieceLabel(p) + " 复核通过，进入「" + p.stage + "」", { pieceId: p.id, stage: p.stage });
      });
    }

    return {
      STAGES: STAGES,
      CONST: { MOISTURE_LIMIT: MOISTURE_LIMIT, RECHECK_DAYS: RECHECK_DAYS },
      evaluate: function (batch) { return evaluateBatch(batch, clock()); },
      today: clock,
      createPiece: createPiece,
      createBatch: createBatch,
      issue: issue,
      recheck: recheck,
      setProgress: setProgress,
      correct: correct,
      approve: approve
    };
  }

  global.Rules = { createService: createService, evaluateBatch: evaluateBatch, STAGES: STAGES };
})(window);
