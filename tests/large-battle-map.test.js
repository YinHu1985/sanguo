import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";

const map = JSON.parse(await readFile(new URL("../src/data/battle-map.json", import.meta.url), "utf8"));
const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const scenario = JSON.parse(await readFile(new URL("./fixtures/legacy-scenario.json", import.meta.url), "utf8"));
const key = (position) => `${position.x},${position.y}`;

function makeBattle() {
  const sourceCity = structuredClone(scenario.cities.find((city) => city.id === "xiaopei"));
  const targetCity = { ...structuredClone(scenario.cities.find((city) => city.id === "puyang")),
    officerIds: ["xiahou-dun"], troops: 3000, food: 100000, gold: 1000 };
  return new BattleEngine({ sourceCity, targetCity, divisions: [{ officerIds: ["guan-yu"], troops: 3000 }],
    officers: structuredClone(scenario.officers), rules, map: structuredClone(map), supplies: { food: 100000, gold: 1000 },
    playerSide: "enemy", rng: () => 0.99 });
}

test("production field doubles both axes to eighteen by fourteen without duplicate strongholds", () => {
  assert.equal(map.width, 18);
  assert.equal(map.height, 14);
  assert.equal(map.terrain.length, 252);
  assert.deepEqual(map.stronghold, { x: 13, y: 7 });
  assert.equal(map.terrain.filter((terrain) => terrain === "fort").length, 1);
  assert.equal(map.terrain[map.stronghold.y * map.width + map.stronghold.x], "fort");
  assert.ok(map.stronghold.x >= 0 && map.stronghold.x < map.width);
  assert.ok(map.stronghold.y >= 0 && map.stronghold.y < map.height);
  assert.ok(map.terrain.every((terrain) => Object.hasOwn(rules.terrain, terrain)));
});

test("all five attacking and defending starts are legal, separate, and outside the main stronghold", () => {
  assert.equal(map.attackerStarts.length, 5);
  assert.equal(map.defenderStarts.length, 5);
  const starts = [...map.attackerStarts, ...map.defenderStarts];
  assert.equal(new Set(starts.map(key)).size, 10);
  for (const position of starts) {
    assert.ok(position.x >= 0 && position.x < map.width && position.y >= 0 && position.y < map.height);
    assert.notEqual(key(position), key(map.stronghold));
    assert.equal(map.terrain[position.y * map.width + position.x], "plain");
  }
  assert.ok(map.attackerStarts.every((position) => position.x < map.width / 2));
  assert.ok(map.defenderStarts.every((position) => position.x > map.width / 2));
  assert.deepEqual(map.attackerStarts, [4, 6, 8, 10, 12].map((y) => ({ x: 3, y })));
  assert.deepEqual(map.defenderStarts, [4, 6, 8, 10, 12].map((y) => ({ x: 12, y })));
});

test("the larger front-facing staggered grid retains six reciprocal neighbors and connects every tile", () => {
  const battle = makeBattle();
  for (let y = 1; y < map.height - 1; y += 1) {
    for (let x = 1; x < map.width - 1; x += 1) {
      const neighbors = battle.neighbors({ x, y });
      assert.equal(neighbors.length, 6);
      for (const neighbor of neighbors) assert.ok(battle.neighbors(neighbor).some((back) => back.x === x && back.y === y));
    }
  }
  const seen = new Set([key(map.stronghold)]);
  const frontier = [map.stronghold];
  for (let cursor = 0; cursor < frontier.length; cursor += 1) {
    for (const neighbor of battle.neighbors(frontier[cursor])) {
      if (seen.has(key(neighbor)) || !Number.isFinite(battle.movementCostAt(neighbor.x, neighbor.y))) continue;
      seen.add(key(neighbor));
      frontier.push(neighbor);
    }
  }
  assert.equal(seen.size, map.width * map.height);
});

test("every deployment has a practical terrain-weighted route to the sole main stronghold", () => {
  const battle = makeBattle();
  for (const start of [...map.attackerStarts, ...map.defenderStarts]) {
    const costs = new Map([[key(start), 0]]);
    const frontier = [{ ...start, cost: 0 }];
    while (frontier.length) {
      frontier.sort((first, second) => first.cost - second.cost);
      const current = frontier.shift();
      if (key(current) === key(map.stronghold)) break;
      for (const neighbor of battle.neighbors(current)) {
        const cost = current.cost + battle.movementCostAt(neighbor.x, neighbor.y);
        if (cost >= (costs.get(key(neighbor)) ?? Infinity)) continue;
        costs.set(key(neighbor), cost);
        frontier.push({ ...neighbor, cost });
      }
    }
    assert.ok(costs.get(key(map.stronghold)) <= 40, `${key(start)} must reach the objective well inside the thirty-day budget`);
  }
});

test("attacking AI still reaches the expanded map's stronghold one legal step at a time", () => {
  const battle = makeBattle();
  const defender = battle.fieldUnits("enemy")[0];
  defender.position = { x: map.width - 1, y: map.height - 1 };
  let actions = 0;
  let moves = 0;
  while (battle.status === "active" && battle.phase === "field" && actions < 500) {
    actions += 1;
    const unit = battle.activeUnit;
    assert.ok(unit);
    if (unit.side === battle.playerSide) {
      battle.wait();
      continue;
    }
    const before = { ...unit.position };
    const result = battle.runEnemyTurn();
    assert.equal(result.ok, true);
    if (result.action === "move") {
      moves += 1;
      assert.ok(battle.neighbors(before).some((tile) => tile.x === unit.position.x && tile.y === unit.position.y));
      assert.equal(result.cost, battle.movementCostAt(unit.position.x, unit.position.y));
    }
  }
  assert.ok(moves >= 10, "the expanded battlefield should involve a real approach march");
  assert.ok(actions < 500, "AI must not loop without advancing toward its objective");
  assert.equal(battle.status, "active");
  assert.equal(battle.phase, "siege_transition");
  assert.equal(battle.pendingDecision.kind, "external");
  assert.ok(battle.day < 10, "terrain routes must not spend most of the campaign limit merely approaching the objective");
  assert.deepEqual(battle.livingUnits("ally")[0].position, map.stronghold);
});
