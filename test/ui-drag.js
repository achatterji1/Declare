const assert = require("assert");
const puppeteer = require("puppeteer-core");

const URL = process.env.DECLARE_URL || "http://127.0.0.1:8765/";
const shotDir = process.env.SHOT_DIR || "/tmp/declare-shots";
const fs = require("fs");
fs.mkdirSync(shotDir, { recursive: true });

function hand(p, i) {
  return `.card[data-zone="hand"][data-p="${p}"][data-i="${i}"]`;
}
const centerSel = "#center .card[data-zone='center']";

async function drag(page, fromSel, toSel) {
  const from = await page.$eval(fromSel, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent };
  });
  const to = await page.$eval(toSel, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 28, from.y + 20, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  return { from, to };
}
async function drop(page) {
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 80));
}

async function shot(page, name) {
  const path = shotDir + "/" + name + ".png";
  await page.screenshot({ path });
  return path;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1200,900"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  page.on("pageerror", (err) => console.error("PAGE", err));
  await page.goto(URL, { waitUntil: "networkidle0" });
  await page.evaluate(() => deal(2));
  await page.evaluate(() => { window.__cpuSoon = cpuSoon; cpuSoon = function () {}; });
  await page.click("#readyBtn");
  await page.waitForFunction(() => G && G.phase === "draw", { timeout: 4000 });

  const chrome = await page.evaluate(() => {
    const text = (id) => {
      const el = document.getElementById(id);
      return el ? el.textContent.trim() : null;
    };
    const row = document.querySelector(".action-row");
    const ids = ["draw", "leave", "power", "call"].map((id) => document.getElementById(id).parentElement === row);
    const gone = ["claim", "swap", "discard", "confirmTrade", "skipTrade", "passChain"].map((id) => !!document.getElementById(id));
    const draw = document.getElementById("draw").getBoundingClientRect();
    const quit = document.getElementById("quit").getBoundingClientRect();
    const redeal = getComputedStyle(document.getElementById("redeal")).display;
    return {
      labels: ["draw", "leave", "power", "call", "quit", "redeal"].map(text),
      inRow: ids,
      gone,
      gap: quit.top - draw.bottom,
      quitBelow: quit.top > row.getBoundingClientRect().bottom,
      redeal
    };
  });
  assert.deepStrictEqual(chrome.labels, ["Draw", "Pass", "Use power", "Declare", "Quit", "New deal"]);
  assert.ok(chrome.inRow.every(Boolean), "action buttons stay in the action row");
  assert.ok(chrome.gone.every((g) => g === false), "card-action buttons are gone");
  assert.ok(chrome.gap > 140, "quit is far from Draw, gap " + chrome.gap);
  assert.ok(chrome.quitBelow, "quit is not in the action row");
  assert.strictEqual(chrome.redeal, "none");

  await page.evaluate(() => {
    G.players[0].slots[0] = { r: "9", s: "C", known: [false, false] };
    G.players[0].slots[1] = { r: "4", s: "D", known: [false, false] };
    G.players[0].slots[2] = { r: "3", s: "H", known: [true, false] };
    G.players[0].slots[3] = { r: "Q", s: "S", known: [true, false] };
    G.deck.push({ r: "A", s: "D" });
    G.pile = [];
    G.phase = "draw";
    G.turn = 0;
    G.free = false;
    render();
  });
  await page.click("#draw");
  const drawn = await page.evaluate(() => ({ phase: G.phase, top: G.pile[G.pile.length - 1].r }));
  assert.strictEqual(drawn.phase, "act");
  assert.strictEqual(drawn.top, "A");

  await drag(page, centerSel, hand(0, 3));
  const mid = await page.evaluate(() => ({
    targets: document.querySelectorAll(".drop-ok").length,
    queen: document.querySelector(".card[data-p='0'][data-i='3']").className,
    opp: document.querySelector(".card[data-p='1'][data-i='0']").textContent
  }));
  assert.ok(mid.targets >= 2, "drop targets show while dragging, got " + mid.targets);
  assert.ok(mid.queen.indexOf("drop-ok") >= 0, "queen is a drop target");
  await shot(page, "ace-drag-targets");
  await drop(page);
  const swapped = await page.evaluate(() => ({
    top: G.pile[G.pile.length - 1] && G.pile[G.pile.length - 1].r,
    slot: G.players[0].slots[3] && G.players[0].slots[3].r,
    known: G.players[0].slots[3] && G.players[0].slots[3].known[0],
    text: document.querySelector(".card[data-p='0'][data-i='3']").textContent,
    center: document.querySelector("#center .card[data-zone='center']").textContent
  }));
  assert.strictEqual(swapped.top, "Q", JSON.stringify(swapped));
  assert.strictEqual(swapped.slot, "A");
  assert.strictEqual(swapped.known, false);
  assert.strictEqual(swapped.text, "??");
  assert.ok(swapped.center.indexOf("Q") === 0);
  await shot(page, "ace-swapped");

  async function lay(pile, mine, opp) {
    await page.evaluate((pile, mine, opp) => {
      G.turn = 0;
      G.phase = "act";
      G.free = false;
      G.intent = null;
      G.pick = [];
      G.chainPid = null;
      G.chainRank = null;
      G.dumpGive = null;
      G.keepBoth = null;
      G.power = null;
      G.declarer = null;
      G.pile = pile;
      G.players[0].slots = mine;
      G.players[1].slots = opp;
      G.players[0].declared = false;
      G.players[1].declared = false;
      render();
    }, pile, mine, opp);
  }
  const C = (r, s, known) => ({ r, s, known: [!!known, false] });

  await lay([{ r: "5", s: "H" }], [C("7", "C"), C("9", "D"), C("3", "S", true), C("K", "C")], [C("4", "H"), C("8", "S"), C("J", "D"), C("2", "C")]);
  const beforeIllegal = await page.evaluate(() => JSON.stringify({ pile: G.pile, mine: G.players[0].slots, phase: G.phase }));
  await drag(page, centerSel, "#log");
  await drop(page);
  const afterIllegal = await page.evaluate(() => JSON.stringify({ pile: G.pile, mine: G.players[0].slots, phase: G.phase }));
  assert.strictEqual(afterIllegal, beforeIllegal, "illegal drop snaps back");

  await drag(page, hand(0, 0), "#center .pile");
  const oppStill = await page.evaluate(() => document.querySelector(".card[data-p='1'][data-i='0']").textContent);
  assert.strictEqual(oppStill, "??");
  await drop(page);
  const wrong = await page.evaluate(() => {
    const kb = G.keepBoth;
    const cards = [...document.querySelectorAll(".card")].map((el) => el.getAttribute("data-p") + ":" + el.getAttribute("data-i") + "=" + el.textContent);
    if (!kb) return { missing: true, phase: G.phase, log: document.getElementById("log").textContent, cards, err: document.getElementById("err").textContent };
    const texts = [kb.handI, kb.placedI].map((i) => {
      const el = document.querySelector(".card[data-p='0'][data-i='" + i + "']");
      return el ? el.textContent : "MISSING " + i;
    });
    G.players[0].slots[kb.handI].known[0] = false;
    G.players[0].slots[kb.placedI].known[0] = false;
    render();
    const still = [kb.handI, kb.placedI].map((i) => document.querySelector(".card[data-p='0'][data-i='" + i + "']").textContent);
    return {
      phase: G.phase,
      turn: G.turn,
      pile: G.pile.map((c) => c.r),
      texts,
      still,
      flashes: document.querySelectorAll(".card.flash").length,
      center: document.getElementById("center").innerText
    };
  });
  assert.strictEqual(wrong.phase, "keepBoth");
  assert.strictEqual(wrong.turn, 0);
  assert.deepStrictEqual(wrong.pile, []);
  assert.deepStrictEqual(wrong.texts.slice().sort(), ["5♥", "7♣"].sort());
  assert.deepStrictEqual(wrong.still.slice().sort(), wrong.texts.slice().sort());
  assert.strictEqual(wrong.flashes, 2);
  assert.ok(wrong.center.indexOf("5") < 0 && wrong.center.indexOf("7") < 0);
  await shot(page, "wrong-discard-flash");
  await page.waitForFunction(() => G.phase === "draw" && G.turn === 1, { timeout: 3000 });
  const hidden = await page.evaluate(() => ({
    fives: [...document.querySelectorAll(".card[data-p='0']")].map((el) => el.textContent).filter((t) => t.indexOf("5") === 0),
    sevens: [...document.querySelectorAll(".card[data-p='0']")].map((el) => el.textContent).filter((t) => t.indexOf("7") === 0)
  }));
  assert.deepStrictEqual(hidden.fives, []);
  assert.deepStrictEqual(hidden.sevens, []);

  await lay([{ r: "7", s: "D" }], [C("9", "C"), C("4", "D"), C("3", "S", true), C("K", "C")], [C("Q", "H"), C("8", "S"), C("J", "D"), C("2", "C")]);
  await drag(page, centerSel, hand(1, 0));
  const hiddenOpp = await page.evaluate(() => document.querySelector(".card[data-p='1'][data-i='0']").textContent);
  assert.strictEqual(hiddenOpp, "??", "opponent card stays face down until the drop");
  await drop(page);
  const dumped = await page.evaluate(() => {
    const kb = G.keepBoth;
    const texts = [kb.handI, kb.placedI].map((i) => document.querySelector(".card[data-p='0'][data-i='" + i + "']").textContent);
    return {
      phase: G.phase,
      opp: G.players[1].slots[0],
      pile: G.pile.map((c) => c.r + c.s),
      texts,
      flashes: document.querySelectorAll(".card.flash").length,
      center: document.querySelector("#center").innerText
    };
  });
  assert.strictEqual(dumped.phase, "keepBoth");
  assert.strictEqual(dumped.opp, null);
  assert.deepStrictEqual(dumped.pile, []);
  assert.deepStrictEqual(dumped.texts.slice().sort(), ["7♦", "Q♥"].sort());
  assert.strictEqual(dumped.flashes, 2);
  assert.ok(dumped.center.indexOf("7") < 0 && dumped.center.indexOf("Q") < 0);
  await shot(page, "wrong-dump-flash");
  await page.waitForFunction(() => G.phase !== "keepBoth", { timeout: 3000 });

  await lay([{ r: "5", s: "H" }], [C("5", "C"), C("9", "D"), C("3", "S"), C("K", "C")], [C("4", "H"), C("8", "S"), C("J", "D"), C("2", "C")]);
  await drag(page, hand(0, 0), "#center .pile");
  await drop(page);
  const legalDiscard = await page.evaluate(() => ({
    phase: G.phase,
    slot: G.players[0].slots[0],
    top: G.pile[G.pile.length - 1].r + G.pile[G.pile.length - 1].s
  }));
  assert.notStrictEqual(legalDiscard.phase, "keepBoth");
  assert.strictEqual(legalDiscard.slot, null);
  assert.strictEqual(legalDiscard.top, "5C");

  await lay([{ r: "8", s: "D" }], [C("9", "C"), C("4", "D"), C("3", "S"), C("K", "C")], [C("4", "H"), C("8", "S"), C("J", "D"), C("2", "C")]);
  await drag(page, centerSel, hand(1, 1));
  await drop(page);
  const legalDump = await page.evaluate(() => ({ phase: G.phase, opp: G.players[1].slots[1], top: G.pile[G.pile.length - 1].s }));
  assert.strictEqual(legalDump.phase, "dumpGive");
  assert.strictEqual(legalDump.opp, null);
  assert.strictEqual(legalDump.top, "S");
  await drag(page, hand(0, 0), hand(1, 1));
  await drop(page);
  const gave = await page.evaluate(() => ({
    phase: G.phase,
    got: G.players[1].slots[1] && G.players[1].slots[1].r,
    face: document.querySelector(".card[data-p='1'][data-i='1']").textContent
  }));
  assert.strictEqual(gave.got, "9");
  assert.strictEqual(gave.face, "??");

  await lay([{ r: "A", s: "H" }], [C("9", "C"), C("4", "D"), C("3", "S", true), C("Q", "C", true)], [C("4", "H"), C("8", "S"), C("J", "D"), C("2", "C")]);
  await page.evaluate(() => { G.phase = "draw"; G.free = true; G.turn = 0; render(); });
  await drag(page, centerSel, hand(0, 3));
  await drop(page);
  const picked = await page.evaluate(() => ({
    top: G.pile[G.pile.length - 1].r,
    slot: G.players[0].slots[3].r,
    known: G.players[0].slots[3].known[0],
    text: document.querySelector(".card[data-p='0'][data-i='3']").textContent
  }));
  assert.strictEqual(picked.top, "Q");
  assert.strictEqual(picked.slot, "A");
  assert.strictEqual(picked.known, false);
  assert.strictEqual(picked.text, "??");

  await page.evaluate(() => { G.phase = "act"; G.turn = 0; G.pile = [{ r: "6", s: "C" }]; G.free = false; render(); });
  await page.click("#leave");
  const passed = await page.evaluate(() => ({ free: G.free, top: G.pile[G.pile.length - 1].r, turn: G.turn, phase: G.phase }));
  assert.strictEqual(passed.free, true);
  assert.strictEqual(passed.top, "6");
  assert.strictEqual(passed.turn, 1);
  assert.strictEqual(passed.phase, "draw");

  await lay([{ r: "Q", s: "H" }], [C("9", "C"), C("4", "D"), C("3", "S"), C("K", "C")], [C("2", "H"), C("8", "S"), C("J", "D"), C("5", "C")]);
  await page.click("#power");
  await drag(page, hand(0, 3), hand(1, 0));
  await drop(page);
  const traded = await page.evaluate(() => ({
    mine: G.players[0].slots[3] && G.players[0].slots[3].r,
    opp: G.players[1].slots[0] && G.players[1].slots[0].r,
    phase: G.phase
  }));
  assert.strictEqual(traded.mine, "2");
  assert.strictEqual(traded.opp, "K");
  assert.notStrictEqual(traded.phase, "power");

  const touch = await page.evaluate(() => {
    G.turn = 0;
    G.phase = "act";
    G.free = false;
    G.power = null;
    G.pile = [{ r: "4", s: "S" }];
    G.players[0].slots[1] = { r: "9", s: "H", known: [false, false] };
    G.declarer = null;
    render();
    const src = document.querySelector(".card[data-p='0'][data-i='1']");
    const pile = document.querySelector("#center .pile");
    const s = src.getBoundingClientRect();
    const d = pile.getBoundingClientRect();
    const ptr = (type, x, y, buttons) => src.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", button: 0, buttons: buttons, clientX: x, clientY: y
    }));
    ptr("pointerdown", s.left + 10, s.top + 10, 1);
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", buttons: 1, clientX: s.left + 40, clientY: s.top + 40 }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", buttons: 1, clientX: d.left + d.width / 2, clientY: d.top + d.height / 2 }));
    const targets = document.querySelectorAll(".drop-ok").length;
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", buttons: 0, clientX: d.left + d.width / 2, clientY: d.top + d.height / 2 }));
    return { targets };
  });
  await new Promise((r) => setTimeout(r, 80));
  const touchAfter = await page.evaluate(() => ({ phase: G.phase, slot: G.players[0].slots[1] }));
  assert.ok(touch.targets >= 1, "touch drag shows a drop target");
  assert.strictEqual(touchAfter.phase, "keepBoth");
  assert.ok(touchAfter.slot && touchAfter.slot.r === "9");
  await page.waitForFunction(() => G.phase !== "keepBoth", { timeout: 3000 });

  await page.evaluate(() => { cpuSoon = window.__cpuSoon; deal(2); });
  await page.click("#readyBtn");
  await page.waitForFunction(() => G && G.phase !== "memorize", { timeout: 4000 });
  let sawDraw = false, sawPass = false, sawDiscard = false, sawSwap = false, sawPick = false, sawDump = false;
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const action = await page.evaluate(() => {
      if (!G) return { type: "wait" };
      if (G.phase === "reveal") return { type: "done" };
      if (G.phase === "memorize") return { type: "ready" };
      if (G.phase === "keepBoth" || G.phase === "peekReveal") return { type: "wait" };
      if (G.turn !== 0) return { type: "wait" };
      const sel = (p, i) => ".card[data-zone='hand'][data-p='" + p + "'][data-i='" + i + "']";
      if (G.phase === "dumpGive") {
        const i = G.players[0].slots.findIndex(Boolean);
        return { type: "drag", from: sel(0, i), to: sel(G.dumpGive.oppPid, G.dumpGive.emptiedI), kind: "give" };
      }
      if (G.phase === "chain") {
        const own = (G.pick || []).map((k) => k.split(":")).find((p) => Number(p[0]) === 0);
        if (own) return { type: "drag", from: sel(0, Number(own[1])), to: "#center .pile", kind: "discard" };
        return { type: "pass" };
      }
      if (G.phase === "power") {
        if (G.powerStep === "k-trade") return { type: "pass" };
        if (G.powerStep === "q-mine" || G.powerStep === "q-theirs") {
          const mineI = G.powerStep === "q-theirs" && G.powerTarget ? G.powerTarget.i : G.players[0].slots.findIndex(Boolean);
          const oppI = G.players[1].slots.findIndex(Boolean);
          if (mineI < 0 || oppI < 0) return { type: "pass" };
          return { type: "drag", from: sel(0, mineI), to: sel(1, oppI), kind: "q" };
        }
        const key = (G.pick || [])[0];
        if (!key) return { type: "wait" };
        const parts = key.split(":");
        return { type: "click", sel: sel(parts[0], parts[1]) };
      }
      if (G.phase === "draw") {
        if (G.free && G.pile.length && G.players[0].slots.some(Boolean)) {
          const i = G.players[0].slots.findIndex((c) => c);
          return { type: "drag", from: "#center .card[data-zone='center']", to: sel(0, i), kind: "pick" };
        }
        if ((G._hands || 0) >= 4) return { type: "declare" };
        return { type: "draw" };
      }
      if (G.phase === "act") {
        const top = G.pile[G.pile.length - 1];
        const match = G.players[0].slots.findIndex((c) => c && c.r === top.r);
        if (match >= 0) return { type: "drag", from: sel(0, match), to: "#center .pile", kind: "discard" };
        const give = G.players[0].slots.findIndex((c) => c && (c.r === "K" || c.r === "Q" || c.r === "J" || Number(c.r) >= 8));
        if (give >= 0 && ["A", "2", "3", "4"].indexOf(top.r) >= 0) {
          return { type: "drag", from: "#center .card[data-zone='center']", to: sel(0, give), kind: "swap" };
        }
        const opp = G.players[1].slots.findIndex(Boolean);
        if (opp >= 0 && !G._dumped) {
          G._dumped = true;
          return { type: "drag", from: "#center .card[data-zone='center']", to: sel(1, opp), kind: "dump" };
        }
        return { type: "pass" };
      }
      return { type: "wait" };
    });
    if (action.type === "done") break;
    if (action.type === "wait") { await new Promise((r) => setTimeout(r, 250)); continue; }
    if (action.type === "ready") { await page.click("#readyBtn"); continue; }
    if (action.type === "draw") { sawDraw = true; await page.evaluate(() => { G._hands = (G._hands || 0) + 1; }); await page.click("#draw"); continue; }
    if (action.type === "pass") { sawPass = true; await page.click("#leave"); continue; }
    if (action.type === "declare") { await page.click("#call"); continue; }
    if (action.type === "click") { await page.click(action.sel); continue; }
    if (action.kind === "discard") sawDiscard = true;
    if (action.kind === "swap") sawSwap = true;
    if (action.kind === "pick") sawPick = true;
    if (action.kind === "dump") sawDump = true;
    await drag(page, action.from, action.to);
    await drop(page);
  }
  const end = await page.evaluate(() => ({ phase: G && G.phase, redeal: getComputedStyle(document.getElementById("redeal")).display, log: document.getElementById("log").textContent }));
  assert.strictEqual(end.phase, "reveal", "full hand did not finish: " + end.log);
  assert.notStrictEqual(end.redeal, "none");
  assert.ok(sawDraw && sawDiscard && sawPick && sawDump, JSON.stringify({ sawDraw, sawPass, sawDiscard, sawSwap, sawPick, sawDump }));
  await shot(page, "round-over");

  await page.click("#quit");
  const left = await page.evaluate(() => ({
    table: document.getElementById("table").style.display,
    setup: document.getElementById("setup").style.display,
    game: G
  }));
  assert.strictEqual(left.table, "none");
  assert.strictEqual(left.setup, "block");
  assert.strictEqual(left.game, null);

  console.log("ui drag ok", { sawDraw, sawPass, sawDiscard, sawSwap, sawPick, sawDump });
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
