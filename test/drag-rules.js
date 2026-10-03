const assert = require("assert");
const { makeDeal, handleAction, publicState, endKeepBothReveal } = require("../server");

function ws() {
  return { readyState: 1, sent: [], send(d) { this.sent.push(JSON.parse(d)); } };
}
function roomWith(G) {
  return {
    code: "TEST", n: 2, cardsN: 4, status: "playing",
    seats: [{ ws: ws(), name: "A" }, { ws: ws(), name: "B" }],
    G, memorizeTimer: null, keepBothTimer: null, peekTimer: null
  };
}
function card(r, s) {
  return { r, s, known: [false, false] };
}
function base() {
  const G = makeDeal(2, 4);
  G.phase = "act";
  G.turn = 0;
  G.free = false;
  G.intent = null;
  G.pick = [];
  G.pile = [{ r: "5", s: "H" }];
  G.players[0].slots = [card("7", "C"), card("9", "D"), card("3", "S"), card("K", "C")];
  G.players[1].slots = [card("4", "H"), card("8", "S"), card("J", "D"), card("2", "C")];
  G.players[0].declared = false;
  G.players[1].declared = false;
  G.declarer = null;
  return roomWith(G);
}
function ranks(state, pid) {
  return state.players[pid].slots.map((c) => (c && c.r) || null);
}
function flashed(state) {
  const kb = state.keepBoth;
  assert.ok(kb, "keepBoth payload");
  const slots = state.players[kb.pid].slots;
  return [slots[kb.handI], slots[kb.placedI]];
}

function testWrongDiscardPublic() {
  const room = base();
  handleAction(room, 0, { action: "drag", gesture: "discard", p: 0, i: 0 });
  const G = room.G;
  assert.strictEqual(G.phase, "keepBoth");
  assert.strictEqual(G.turn, 0);
  assert.ok(!G.pile.some((c) => c.r === "5" && c.s === "H"), "center 5 is not left on the pile");
  const mine = G.players[0].slots.filter(Boolean).map((c) => c.r).sort();
  assert.deepStrictEqual(mine, ["3", "5", "7", "9", "K"]);
  for (const viewer of [0, 1]) {
    const state = publicState(room, viewer);
    const pair = flashed(state);
    const rs = pair.map((c) => c && c.r).sort();
    assert.deepStrictEqual(rs, ["5", "7"], "viewer " + viewer + " sees both cards face up");
    assert.ok(pair.every((c) => c && c.known === true));
  }
  endKeepBothReveal(room);
  assert.strictEqual(room.G.phase, "draw");
  assert.strictEqual(room.G.turn, 1);
  for (const viewer of [0, 1]) {
    const state = publicState(room, viewer);
    assert.strictEqual(state.keepBoth, null);
    const fives = state.players[0].slots.filter((c) => c && c.r === "5");
    const sevens = state.players[0].slots.filter((c) => c && c.r === "7");
    assert.strictEqual(fives.length, 0, "5 is face down for viewer " + viewer);
    assert.strictEqual(sevens.length, 0, "7 is face down for viewer " + viewer);
    assert.ok(state.players[0].slots.filter(Boolean).length >= 5);
  }
  clearTimeout(room.keepBothTimer);
}

function testWrongDumpPublic() {
  const room = base();
  room.G.pile = [{ r: "7", s: "D" }];
  room.G.players[1].slots[0] = card("K", "S");
  handleAction(room, 0, { action: "drag", gesture: "dump", p: 1, i: 0 });
  const G = room.G;
  assert.strictEqual(G.phase, "keepBoth");
  assert.strictEqual(G.players[1].slots[0], null);
  assert.deepStrictEqual(G.pile, [], "neither card stays in the center");
  const mine = G.players[0].slots.filter(Boolean).map((c) => c.r).sort();
  assert.ok(mine.includes("7") && mine.includes("K"));
  for (const viewer of [0, 1]) {
    const pair = flashed(publicState(room, viewer)).map((c) => c && c.r).sort();
    assert.deepStrictEqual(pair, ["7", "K"], "viewer " + viewer + " sees the wrong dump");
  }
  const before = room.G.turn;
  endKeepBothReveal(room);
  assert.strictEqual(room.G.turn, (before + 1) % 2);
  assert.notStrictEqual(room.G.phase, "keepBoth");
  clearTimeout(room.keepBothTimer);
}

function testLegalDiscardAndDump() {
  const room = base();
  room.G.players[0].slots[0] = card("5", "C");
  handleAction(room, 0, { action: "drag", gesture: "discard", p: 0, i: 0 });
  assert.notStrictEqual(room.G.phase, "keepBoth");
  assert.strictEqual(room.G.pile[room.G.pile.length - 1].r, "5");
  assert.strictEqual(room.G.players[0].slots[0], null);
  assert.strictEqual(room.G.turn, 1);

  const room2 = base();
  room2.G.pile = [{ r: "7", s: "D" }];
  room2.G.players[1].slots[1] = card("7", "H");
  handleAction(room2, 0, { action: "drag", gesture: "dump", p: 1, i: 1 });
  assert.strictEqual(room2.G.phase, "dumpGive");
  assert.strictEqual(room2.G.players[1].slots[1], null);
  assert.strictEqual(room2.G.pile[room2.G.pile.length - 1].r, "7");
  assert.strictEqual(room2.G.pile[room2.G.pile.length - 1].s, "H");
  handleAction(room2, 0, { action: "drag", gesture: "give", p: 0, i: 0 });
  assert.strictEqual(room2.G.phase, "draw");
  assert.strictEqual(room2.G.turn, 1);
  assert.strictEqual(room2.G.players[1].slots[1].r, "7");
  assert.ok(room2.G.players[1].slots[1].known.every((k) => k === false));
}

function testSwapAndPick() {
  const room = base();
  room.G.pile = [{ r: "A", s: "D" }];
  room.G.players[0].slots[3] = card("Q", "S");
  room.G.players[0].slots[3].known[0] = true;
  handleAction(room, 0, { action: "drag", gesture: "swap", p: 0, i: 3 });
  assert.strictEqual(room.G.pile[room.G.pile.length - 1].r, "Q");
  assert.strictEqual(room.G.players[0].slots[3].r, "A");
  assert.ok(room.G.players[0].slots[3].known.every((k) => k === false), "swapped-in ace is face down");

  const room2 = base();
  room2.G.phase = "draw";
  room2.G.free = true;
  room2.G.pile = [{ r: "A", s: "H" }];
  const before = room2.G.players[0].slots[2].r;
  handleAction(room2, 0, { action: "drag", gesture: "claim", p: 0, i: 2 });
  assert.strictEqual(room2.G.pile[room2.G.pile.length - 1].r, before);
  assert.strictEqual(room2.G.players[0].slots[2].r, "A");
  assert.ok(room2.G.players[0].slots[2].known.every((k) => k === false));
}

function testIllegalDragNoChange() {
  const room = base();
  room.G.phase = "draw";
  room.G.free = false;
  const before = JSON.stringify(room.G.players[0].slots.map((c) => c && c.r));
  const pile = room.G.pile.length;
  handleAction(room, 0, { action: "drag", gesture: "discard", p: 0, i: 0 });
  handleAction(room, 0, { action: "drag", gesture: "swap", p: 0, i: 1 });
  assert.strictEqual(JSON.stringify(room.G.players[0].slots.map((c) => c && c.r)), before);
  assert.strictEqual(room.G.pile.length, pile);
  assert.strictEqual(room.G.phase, "draw");
  assert.strictEqual(room.G.turn, 0);
}

testWrongDiscardPublic();
testWrongDumpPublic();
testLegalDiscardAndDump();
testSwapAndPick();
testIllegalDragNoChange();
console.log("server drag rules ok");
