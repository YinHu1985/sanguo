/**
 * Stable, editable city territories for political map colouring.
 * Rebuild: node scripts/build-strategic-territories.mjs
 *
 * These are GAMEPLAY nearest-city territories, NOT historical commandery
 * boundaries. Ownership belongs to the campaign save and never changes this
 * geometry. Individual cell polygons may later be replaced with authored ones.
 * Coast/lake vectors reuse the existing public-domain Natural Earth basemap.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTerritoryEdges, createVoronoiCells, polygonArea, polygonPath, projectPoint, snapPoint } from "./lib/territory-geometry.mjs";

// Outside settlements bound the unmodelled hinterland. They have no faction,
// city, economy, route or selectable polygon. This prevents a frontier city
// claiming every distant plateau/peninsula just because no other city is near.
export const UNMANAGED_SITES = [
  [92, 40], [93, 43], [96, 43], [99, 42.3], [102, 41], [105, 40.5],
  [108, 42.5], [112, 43], [116, 43], [120, 44], [124, 44.5], [127, 43],
  [126, 41], [125.5, 39], [127, 37], [129, 35], [124, 34], [125, 30],
  [124, 26], [121, 22], [116, 20], [111, 18.5], [108, 18.5], [104.5, 18.5],
  [102, 20], [99, 21], [97, 22], [95, 25], [99, 28], [99, 31],
  [98, 34], [96, 36], [94, 38]
];

// Match the schematic lake already drawn by build-strategic-map.mjs.
export const SCHEMATIC_DONGTING = [[111.85,29.3],[112.3,29.55],[112.65,29.4],[113.1,29.55],[113.2,29.25],[112.95,28.9],[112.6,29.1],[112.4,28.85],[112.1,29.05],[111.85,29.3]];

export function buildTerritoryData(atlas, geography) {
  const projection = structuredClone(atlas.projection);
  const sites = [
    ...atlas.cities.map((city) => ({ id: city.id, point: projectPoint([city.longitude, city.latitude], projection) })),
    ...UNMANAGED_SITES.map((point, index) => ({ id: `unmanaged-${index}`, point: projectPoint(point, projection), unmanaged: true }))
  ];
  const cells = createVoronoiCells(sites, projection);
  const edges = createTerritoryEdges(cells);
  // Mainland only: the atlas has no island cities. Keeping the other Natural
  // Earth polygons would paint Taiwan, Hainan or distant islands from mainland
  // neighbours. Should island cities be added, explicitly add their land ring.
  const mainland = [...geography.land].sort((a, b) => Math.abs(polygonArea(b[0])) - Math.abs(polygonArea(a[0])))[0];
  const projectedPath = (ring) => polygonPath(ring.map((point) => snapPoint(projectPoint(point, projection))));
  return {
    version: 1,
    atlasVersion: atlas.version,
    projection,
    description: "游戏化近邻辖区示意，并非汉末实际郡界；城市归属改变只更新染色，不重新划界。",
    generatedBy: "scripts/build-strategic-territories.mjs",
    attribution: geography.attribution,
    maskInstructions: "SVG mask: white mainland landPath with evenodd fill, then black waterPath with evenodd fill; apply the mask to cells AND edges.",
    coverage: { method: "fixed-city Voronoi with unmanaged frontier sites; mainland land/lake mask", unmanagedSites: UNMANAGED_SITES },
    landPath: mainland.map(projectedPath).join(""),
    waterPath: [...geography.lakes.flatMap((lake) => lake.polygons.flatMap((rings) => rings)), SCHEMATIC_DONGTING].map(projectedPath).join(""),
    cells,
    edges
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const atlas = JSON.parse(await readFile(new URL("../src/data/strategic-atlas.json", import.meta.url), "utf8"));
  const geography = JSON.parse(await readFile(new URL("../src/assets/map/geography.json", import.meta.url), "utf8"));
  const output = new URL("../src/data/strategic-territories.json", import.meta.url);
  const data = buildTerritoryData(atlas, geography);
  await writeFile(output, `${JSON.stringify(data)}\n`);
  console.log(`Built ${data.cells.length} territories, ${data.edges.length} shared edges: ${fileURLToPath(output)}`);
}
