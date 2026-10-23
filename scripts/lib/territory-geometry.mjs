// Dependency-free build-time geometry. All operations use the atlas projection,
// not geographic distances or historical administrative borders.
const EPSILON = 1e-7;

export function polygonArea(points) {
  return points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
}

export function pointInPolygon(point, points, tolerance = EPSILON) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[previous], b = points[index];
    const cross = (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0]);
    if (Math.abs(cross) <= tolerance * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]))
      && point[0] >= Math.min(a[0], b[0]) - tolerance && point[0] <= Math.max(a[0], b[0]) + tolerance
      && point[1] >= Math.min(a[1], b[1]) - tolerance && point[1] <= Math.max(a[1], b[1]) + tolerance) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function cleanPolygon(points) {
  let cleaned = points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    return Math.hypot(point[0] - previous[0], point[1] - previous[1]) > EPSILON;
  });
  cleaned = cleaned.filter((point, index) => {
    const previous = cleaned[(index + cleaned.length - 1) % cleaned.length];
    const next = cleaned[(index + 1) % cleaned.length];
    const cross = (point[0] - previous[0]) * (next[1] - point[1]) - (point[1] - previous[1]) * (next[0] - point[0]);
    return Math.abs(cross) > EPSILON;
  });
  return cleaned;
}

export function clipHalfPlane(points, normal, offset) {
  const result = [];
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    const da = a[0] * normal[0] + a[1] * normal[1] - offset;
    const db = b[0] * normal[0] + b[1] * normal[1] - offset;
    const aInside = da <= EPSILON, bInside = db <= EPSILON;
    if (aInside) result.push(a);
    if (aInside !== bInside) {
      const fraction = da / (da - db);
      result.push([a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction]);
    }
  }
  return cleanPolygon(result);
}

export function projectPoint([longitude, latitude], projection) {
  return [
    (longitude - projection.west) / (projection.east - projection.west) * projection.width,
    (projection.north - latitude) / (projection.north - projection.south) * projection.height
  ];
}

export function polygonPath(points, closed = true) {
  return points.length ? `M${points.map((point) => point.join(",")).join("L")}${closed ? "Z" : ""}` : "";
}

// Snap ALL cells to the same millipixel lattice before creating their paths and
// edges. Adjacent fills and boundary strokes therefore share exact vertices.
export function snapPoint(point) {
  return point.map((coordinate) => Math.round(coordinate * 1000) / 1000);
}

export function createVoronoiCells(sites, bounds) {
  if (new Set(sites.map((site) => site.id)).size !== sites.length) throw new Error("Duplicate territory site id");
  const usedPoints = new Set();
  for (const site of sites) {
    if (!site.point.every(Number.isFinite)) throw new Error(`Invalid territory site ${site.id}`);
    const key = site.point.join(",");
    if (usedPoints.has(key)) throw new Error(`Coincident territory site ${site.id}`);
    usedPoints.add(key);
  }
  return sites.filter((site) => !site.unmanaged).map((site) => {
    let points = [[0, 0], [bounds.width, 0], [bounds.width, bounds.height], [0, bounds.height]];
    for (const other of sites) {
      if (other === site) continue;
      const normal = [other.point[0] - site.point[0], other.point[1] - site.point[1]];
      const midpoint = [(site.point[0] + other.point[0]) / 2, (site.point[1] + other.point[1]) / 2];
      points = clipHalfPlane(points, normal, normal[0] * midpoint[0] + normal[1] * midpoint[1]);
      if (!points.length) throw new Error(`Empty territory for ${site.id}`);
    }
    points = cleanPolygon(points.map(snapPoint));
    if (points.length < 3 || Math.abs(polygonArea(points)) < 1) throw new Error(`Degenerate territory for ${site.id}`);
    return { cityId: site.id, points, path: polygonPath(points) };
  });
}

export function createTerritoryEdges(cells) {
  const shared = new Map();
  for (const cell of cells) {
    for (let index = 0; index < cell.points.length; index++) {
      const points = [cell.points[index], cell.points[(index + 1) % cell.points.length]];
      const key = points.map((point) => point.join(",")).sort().join("|");
      const existing = shared.get(key);
      if (existing) {
        if (existing.cityIds.includes(cell.cityId) || existing.cityIds.length >= 2) throw new Error(`Invalid shared territory edge ${key}`);
        existing.cityIds.push(cell.cityId);
        existing.cityIds.sort();
      } else {
        shared.set(key, { cityIds: [cell.cityId], points, path: polygonPath(points, false) });
      }
    }
  }
  return [...shared.values()];
}
