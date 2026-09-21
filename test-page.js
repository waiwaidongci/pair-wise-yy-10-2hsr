/* 页面集成验证：用 jsdom 真实加载 index.html + 三个业务文件并模拟交互 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("/tmp/node_modules/jsdom");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const dom = new JSDOM(html, {
  runScripts: "outside-only",
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const { window } = dom;

// jsdom 未实现 <dialog>.showModal/close（真实浏览器均支持），测试环境最小补全
if (window.HTMLDialogElement && !window.HTMLDialogElement.prototype.showModal) {
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.open = false; };
}

// 让外部脚本在页面上下文执行
for (const f of ["rules.js", "storage.js", "page.js"]) {
  window.eval(fs.readFileSync(path.join(__dirname, f), "utf8"));
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? " => " + extra : "")); }
}
const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await sleep(50);

  console.log("【页面加载】");
  check("时钟显示今日", $("#clock").textContent.includes("2026-09-21"), $("#clock").textContent);
  check("看板 4 列", $$("#board .col").length === 4);
  check("总览 5 项统计", $$("#summary .stat").length === 5);
  check("批次列表 4 行", $$("#batchList .batch-row").length === 4);
  check("留档列表含 1 个旧版", $$("#archiveList .card").length === 1);
  check("漆线-乙显示“只能留检”标签", $$("#batchList .tag.hold").length >= 2); // 乙 + 丙
  check("漆线-甲显示占用中", $$("#batchList .tag.lock").length >= 1);
  check("请求流水初始为空提示", $("#requestLog").textContent.includes("尚未发生"));

  console.log("【建档】");
  const pieceForm = $("#pieceForm");
  pieceForm.elements.base.value = "瓷胎盏";
  pieceForm.elements.theme.value = "联珠纹";
  pieceForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await sleep(10);
  check("建档后当前工件 +1", $$("#board .card").length === 4); // 3 种子可见卡 + 新件
  check("待领料列出现新件", $$("#board .col")[0].textContent.includes("联珠纹"));
  check("Toast 出现 201", $$("#toasts .toast").some(t => t.textContent.includes("201")));
  check("请求流水记录建档", $("#requestLog").textContent.includes("工件建档"));

  console.log("【领料 409：占用批次】");
  const issueForm = $("#issueForm");
  const pieceSel = issueForm.querySelector('[name="pieceId"]');
  // 显式选中刚建档的新工件
  pieceSel.value = [...pieceSel.options].find(o => o.textContent.includes("联珠纹")).value;
  // 找到漆线-甲(b01)
  issueForm.querySelector('[name="batchId"]').value = "b01";
  issueForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await sleep(20);
  check("409 Toast 为红色样式", $$("#toasts .toast.c409").some(t => t.textContent.includes("BATCH_IN_PROGRESS")));
  check("提示含“不得再领给第二件”", $$("#toasts .toast").some(t => t.textContent.includes("不得再领给第二件")));
  const newPiece = $$("#board .col")[0].querySelector(".card");
  check("新件仍处于待领料（冲突不写入）", newPiece.textContent.includes("未领料"));

  console.log("【领料 422：留检批次】");
  issueForm.querySelector('[name="batchId"]').value = "b02"; // 13.2%
  issueForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await sleep(20);
  check("422 琥珀色 Toast", $$("#toasts .toast.c422").some(t => t.textContent.includes("HOLD_FOR_INSPECTION")));

  console.log("【复检解除留检后领料成功】");
  const recheckForm = $("#recheckForm");
  recheckForm.querySelector('[name="batchId"]').value = "b02";
  recheckForm.elements.moisture.value = "10.2";
  recheckForm.elements.checkedAt.value = "2026-09-21";
  recheckForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await sleep(10);
  check("流水含 RECHECK_PASS", $("#requestLog").textContent.includes("RECHECK_PASS"));
  issueForm.querySelector('[name="batchId"]').value = "b02";
  issueForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await sleep(20);
  check("领料成功 201 ISSUED", $$("#toasts .toast").some(t => t.textContent.includes("201 ISSUED")));
  check("新件进入贴线中列", $$("#board .col")[1].textContent.includes("联珠纹"));

  console.log("【重复领用沿用首次结果】");
  issueForm.querySelector('[name="batchId"]').value = "b02";
  issueForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await sleep(20);
  check("返回 ISSUE_REPLAY", $$("#toasts .toast").some(t => t.textContent.includes("ISSUE_REPLAY")));

  console.log("【进度登记到 100% 释放】");
  const pastingCards = $$("#board .col")[1].querySelectorAll(".card");
  const target = [...pastingCards].find(c => c.textContent.includes("联珠纹"));
  target.querySelector('[data-action="progress"]').click();
  await sleep(10);
  check("进度弹窗已打开", $("#progressDialog").open === true);
  $("#progressInput").value = "100";
  $("#progressSave").click();
  await sleep(10);
  check("进入贴线完成列", $$("#board .col")[2].textContent.includes("联珠纹"));
  check("批次行显示占用已释放", $$("#batchList .batch-row.free").some(r => r.textContent.includes("漆线-乙")));

  console.log("【更正 → 旧版留档 + 待复核】");
  // 对 p01（贴线中 60%）做纹样更正
  const p01card = [...$$("#board .card")].find(c => c.textContent.includes("缠枝莲"));
  p01card.querySelector('[data-action="correct"]').click();
  await sleep(10);
  check("更正弹窗预填原数据", $("#correctTheme").value === "缠枝莲");
  $("#correctTheme").value = "缠枝莲(改)";
  $("#correctSave").click();
  await sleep(10);
  check("新件出现在待复核列", $$("#board .col")[3].textContent.includes("缠枝莲(改)"));
  check("留档列表 +1（旧 v1 进入）", $$("#archiveList .card").length === 2);
  check("留档含冻结进度 60%", $$("#archiveList .card").some(c => c.textContent.includes("60%")));
  check("流水含 CORRECTED", $("#requestLog").textContent.includes("CORRECTED"));
  check("复核通过按钮存在", $$("#board .col")[3].querySelector('[data-action="approve"]'));
  const reviewCard = [...$$("#board .col")[3].querySelectorAll(".card")].find(c => c.textContent.includes("缠枝莲(改)"));
  reviewCard.querySelector('[data-action="approve"]').click();
  await sleep(10);
  check("复核后回到贴线中列", $$("#board .col")[1].textContent.includes("缠枝莲(改)"));

  console.log("【刷新核对】");
  $("#refreshBtn").click();
  await sleep(10);
  check("刷新 Toast 含留检/占用汇总", $$("#toasts .toast").some(t => t.textContent.includes("重新核对")));
  check("流水含 REFRESH", $("#requestLog").textContent.includes("刷新核对"));

  console.log(`\n页面集成结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
