import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildTerritoryData, UNMANAGED_SITES, SCHEMATIC_DONGTING } from "../scripts/build-strategic-territories.mjs";
import { createTerritoryEdges, createVoronoiCells, pointInPolygon, polygonArea, polygonPath, projectPoint, snapPoint } from "../scripts/lib/territory-geometry.mjs";

const atlas = JSON.parse(await readFile(new URL("../src/data/strategic-atlas.json", import.meta.url), "utf8"));
const geography = JSON.parse(await readFile(new URL("../src/assets/map/geography.json", import.meta.url), "utf8"));
const data = JSON.parse(await readFile(new URL("../src/data/strategic-territories.json", import.meta.url), "utf8"));
const sites = atlas.cities.map((city) => ({ id: city.id, point: projectPoint([city.longitude, city.latitude], atlas.projection) }));
const ghostPoints = UNMANAGED_SITES.map((point) => projectPoint(point, atlas.projection));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pointKey = (point) => point.join(",");
const edgeKey = (points) => points.map(pointKey).sort().join("|");
const midpoint = ([a, b]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

test("territory data is a reproducible external asset with exactly one fixed cell per atlas city", () => {
  assert.deepEqual(buildTerritoryData(atlas, geography), data);
  assert.deepEqual(data.projection, atlas.projection);
  assert.equal(data.cells.length, 81);
  assert.equal(new Set(data.cells.map((cell) => cell.cityId)).size, atlas.cities.length);
  assert.deepEqual(data.cells.map((cell) => cell.cityId).sort(), atlas.cities.map((city) => city.id).sort());
  assert.match(data.description, /并非汉末实际郡界/);
  assert.match(data.attribution, /public domain/);
  assert.ok(data.cells.every((cell) => !("factionId" in cell)), "political ownership must not be baked into geometry");
});

test("each city lies inside a finite nondegenerate bounded nearest-city polygon", () => {
  for (const cell of data.cells) {
    const site = sites.find((entry) => entry.id === cell.cityId);
    assert.ok(pointInPolygon(site.point, cell.points), `${site.id} must be inside its own cell`);
    assert.ok(Math.abs(polygonArea(cell.points)) > 1, `${site.id} has positive area`);
    assert.equal(cell.path, polygonPath(cell.points));
    for (const point of cell.points) {
      assert.equal(point.length, 2);
      assert.ok(point.every(Number.isFinite));
      assert.ok(point[0] >= 0 && point[0] <= data.projection.width);
      assert.ok(point[1] >= 0 && point[1] <= data.projection.height);
      for (const other of [...sites.map((entry) => entry.point), ...ghostPoints]) {
        assert.ok(distance(point, site.point) <= distance(point, other) + 0.002, `${site.id}: vertex must not cross another territory`);
      }
    }
  }
});

test("all polygon edges share exact snapped vertices with matching ownership and no internal cracks", () => {
  const expected = new Map();
  for (const cell of data.cells) {
    for (let index = 0; index < cell.points.length; index++) {
      const points = [cell.points[index], cell.points[(index + 1) % cell.points.length]];
      const key = edgeKey(points);
      expected.set(key, [...(expected.get(key) ?? []), cell.cityId].sort());
    }
  }
  assert.equal(data.edges.length, expected.size);
  assert.equal(new Set(data.edges.map((edge) => edgeKey(edge.points))).size, data.edges.length);
  assert.ok(data.edges.filter((edge) => edge.cityIds.length === 2).length > 150);
  for (const edge of data.edges) {
    assert.deepEqual(edge.cityIds, expected.get(edgeKey(edge.points)));
    assert.ok(edge.cityIds.length === 1 || edge.cityIds.length === 2);
    assert.equal(edge.path, polygonPath(edge.points, false));
    assert.ok(distance(...edge.points) > 0);
    const center = midpoint(edge.points);
    const owner = sites.find((site) => site.id === edge.cityIds[0]);
    if (edge.cityIds.length === 2) {
      const neighbor = sites.find((site) => site.id === edge.cityIds[1]);
      assert.ok(Math.abs(distance(center, owner.point) - distance(center, neighbor.point)) <= 0.002);
    } else {
      const atFrame = center[0] === 0 || center[0] === data.projection.width || center[1] === 0 || center[1] === data.projection.height;
      const atGhost = ghostPoints.some((ghost) => Math.abs(distance(center, owner.point) - distance(center, ghost)) <= 0.002);
      assert.ok(atFrame || atGhost, `${owner.id}: unmatched internal boundary would make a visible crack`);
    }
  }
});

test("territory segments have no proper crossings", () => {
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < data.edges.length; i++) {
    const [a, b] = data.edges[i].points;
    for (let j = i + 1; j < data.edges.length; j++) {
      const [c, d] = data.edges[j].points;
      // Shared endpoints and collinear segments are valid junctions, not crossings.
      const properIntersection = cross(a, b, c) * cross(a, b, d) < -1e-8 && cross(c, d, a) * cross(c, d, b) < -1e-8;
      assert.equal(properIntersection, false, `boundaries ${i} and ${j} cross`);
    }
  }
});

test("the unmodelled plateau and Korean peninsula remain unmanaged and island land is masked out", () => {
  for (const point of [[94, 32], [97, 35], [127, 37], [126.5, 40]]) {
    const projected = projectPoint(point, data.projection);
    assert.ok(!data.cells.some((cell) => pointInPolygon(projected, cell.points)), `${point} should remain uncoloured hinterland`);
  }
  const mainland = [...geography.land].sort((a, b) => Math.abs(polygonArea(b[0])) - Math.abs(polygonArea(a[0])))[0];
  assert.ok(pointInPolygon([114, 34], mainland[0]));
  for (const island of [[121, 24], [110, 19]]) assert.equal(pointInPolygon(island, mainland[0]), false);
  assert.equal(data.landPath, mainland.map((ring) => polygonPath(ring.map((point) => snapPoint(projectPoint(point, data.projection))))).join(""));
  assert.ok(pointInPolygon([112.5, 29.25], SCHEMATIC_DONGTING));
  assert.ok(data.waterPath.includes(polygonPath(SCHEMATIC_DONGTING.map((point) => snapPoint(projectPoint(point, data.projection))))));
  assert.match(data.maskInstructions, /black waterPath/);
});

test("half-plane generation handles unmanaged clipping and produces one shared segment", () => {
  const cells = createVoronoiCells([{ id: "a", point: [25, 50] }, { id: "b", point: [75, 50] }], { width: 100, height: 100 });
  assert.equal(Math.abs(polygonArea(cells[0].points)), 5000);
  assert.equal(Math.abs(polygonArea(cells[1].points)), 5000);
  assert.equal(createTerritoryEdges(cells).filter((edge) => edge.cityIds.length === 2).length, 1);
  const bounded = createVoronoiCells([{ id: "a", point: [25, 50] }, { id: "ghost", point: [75, 50], unmanaged: true }], { width: 100, height: 100 });
  assert.equal(bounded.length, 1);
  assert.ok(bounded[0].points.every((point) => point[0] <= 50));
  assert.throws(() => createVoronoiCells([{ id: "a", point: [10, 10] }, { id: "b", point: [10, 10] }], { width: 100, height: 100 }), /Coincident/);
});
