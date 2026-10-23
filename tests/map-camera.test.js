import test from "node:test";
import assert from "node:assert/strict";
import { mapFocusFrame, StrategicMap } from "../src/js/ui/strategic-map.js";

test("city focus is centered between visible left details and right city roster", () => {
  const frame = mapFocusFrame(1280, 800, { left: 326, right: 278, top: 90, bottom: 185 });
  assert.deepEqual(frame, { width: 676, height: 525, x: 664, y: 352.5 });
  assert.ok(frame.x > 326 && frame.x < 1002);
  assert.ok(frame.x > 640, "a wider left HUD nudges focus right, not behind the left city window");
});

test("map overview and narrow viewport focus targets remain on screen", () => {
  assert.deepEqual(mapFocusFrame(1280, 800), { width: 1200, height: 660, x: 640, y: 360 });
  const small = mapFocusFrame(360, 600, { left: 280, right: 40, top: 90, bottom: 185 });
  assert.ok(small.x >= 280 && small.x < 360);
  assert.ok(small.width > 0 && small.height > 0);
});

test("focusCities measures current HUDs before placing a selected city", () => {
  const city = { x: 900, y: 750 };
  const panels = {
    ".city-detail-panel": { getClientRects: () => [1], getBoundingClientRect: () => ({ right: 308 }) },
    ".city-roster-panel": { getClientRects: () => [1], getBoundingClientRect: () => ({ left: 1020 }) }
  };
  const camera = Object.create(StrategicMap.prototype);
  camera.viewport = { clientWidth: 1280, clientHeight: 800,
    closest: () => ({ querySelector: (selector) => panels[selector] }), getBoundingClientRect: () => ({ left: 0, right: 1280 }) };
  camera.projection = { width: 1800, height: 1500 };
  camera.camera = { x: 0, y: 0, scale: 0.5 };
  camera.paint = () => {};
  camera.focusCities([city], { detail: true });
  assert.equal(camera.camera.x + city.x * camera.camera.scale, 664);
  assert.equal(camera.camera.y + city.y * camera.camera.scale, 352.5);
});
