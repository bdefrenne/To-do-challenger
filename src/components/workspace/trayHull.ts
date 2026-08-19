/**
 * The outline that wraps axis-aligned boxes, hugging their silhouette.
 *
 * Each box is padded and the union is traced, so boxes that touch come back as
 * ONE outline around their combined shape — an L, a cross, whatever they form —
 * while boxes standing apart each keep their own. That's the point: the outline
 * only ever claims the space the boxes actually occupy, never the empty canvas a
 * bounding rectangle would sweep up with them.
 *
 * Because every box is axis-aligned, the union is a rectilinear polygon and can
 * be traced exactly — no approximation, no blur-and-threshold trick:
 *
 *   1. Cut the plane on every box edge (`xs`/`ys`) → a grid whose cells are each
 *      wholly inside or wholly outside the union.
 *   2. Emit the cell edges that separate inside from outside, directed so the
 *      inside is consistently on one side.
 *   3. Chain those into closed loops (several, for boxes in separate clusters; a
 *      loop may also be a hole — a courtyard enclosed by boxes).
 *   4. Drop collinear vertices, then round every corner.
 *
 * Corners round both ways: a convex corner curves outward, a concave one (the
 * inside of an L) curves inward, which is what makes a merged run of boxes read
 * as a drawn shape rather than boxes glued together.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Point {
  x: number;
  y: number;
}

/** A traced outline: the SVG path plus the bounds it occupies. */
export interface Hull {
  /** `d` for a single <path> — every loop, each closed with Z. */
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Grow a box on all sides. */
const pad = (b: Box, p: number): Box => ({
  x: b.x - p,
  y: b.y - p,
  w: b.w + p * 2,
  h: b.h + p * 2,
});

const uniqSorted = (vs: number[]): number[] => {
  const out: number[] = [];
  for (const v of [...vs].sort((a, b) => a - b)) {
    if (out.length === 0 || Math.abs(out[out.length - 1] - v) > 1e-6) out.push(v);
  }
  return out;
};

const key = (p: Point) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;

/**
 * Trace the boundary loops of the union of `boxes`.
 *
 * Each loop comes back in the winding the grid walk produces — clockwise in
 * screen coordinates (y down) for an outer boundary, counter-clockwise for a
 * hole — which is exactly what the corner-rounding pass needs to tell a convex
 * corner from a concave one, and what SVG's default fill rule needs to punch
 * holes out rather than fill them in.
 */
function unionLoops(boxes: readonly Box[]): Point[][] {
  const xs = uniqSorted(boxes.flatMap((b) => [b.x, b.x + b.w]));
  const ys = uniqSorted(boxes.flatMap((b) => [b.y, b.y + b.h]));
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  if (nx < 1 || ny < 1) return [];

  // Cell (i,j) is inside the union if any box covers its midpoint. The grid is
  // cut on every box edge, so a cell is never partly covered.
  const inside = (i: number, j: number): boolean => {
    if (i < 0 || j < 0 || i >= nx || j >= ny) return false;
    const cx = (xs[i] + xs[i + 1]) / 2;
    const cy = (ys[j] + ys[j + 1]) / 2;
    return boxes.some(
      (b) => cx > b.x && cx < b.x + b.w && cy > b.y && cy < b.y + b.h,
    );
  };

  const filled: boolean[][] = [];
  for (let i = 0; i < nx; i++) {
    filled[i] = [];
    for (let j = 0; j < ny; j++) filled[i][j] = inside(i, j);
  }

  // Directed boundary edges, walking each filled cell's exposed sides clockwise
  // (screen coords). Keyed by start point so a loop can be chained by lookup;
  // a point can start two edges where two cells meet only diagonally, hence the
  // array — either resolution closes into valid loops.
  const outgoing = new Map<string, Point[]>();
  const push = (from: Point, to: Point) => {
    const k = key(from);
    const list = outgoing.get(k);
    if (list) list.push(to);
    else outgoing.set(k, [to]);
  };

  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!filled[i][j]) continue;
      const x0 = xs[i];
      const x1 = xs[i + 1];
      const y0 = ys[j];
      const y1 = ys[j + 1];
      // Top → right → bottom → left: clockwise, and only the sides whose
      // neighbouring cell is outside the union.
      if (!filled[i][j - 1]) push({ x: x0, y: y0 }, { x: x1, y: y0 });
      if (!filled[i + 1]?.[j]) push({ x: x1, y: y0 }, { x: x1, y: y1 });
      if (!filled[i][j + 1]) push({ x: x1, y: y1 }, { x: x0, y: y1 });
      if (!filled[i - 1]?.[j]) push({ x: x0, y: y1 }, { x: x0, y: y0 });
    }
  }

  // Chain the edges into closed loops, consuming each edge exactly once. Every
  // vertex has as many outgoing as incoming edges, so following `outgoing` from
  // any unconsumed start always returns to it — several passes from the same
  // start point cover the diagonal-touch case, where one vertex belongs to two
  // loops.
  const loops: Point[][] = [];
  // A loop can't be longer than the edges we emitted.
  const maxSteps = nx * ny * 4 + 8;
  for (const startKey of [...outgoing.keys()]) {
    while ((outgoing.get(startKey)?.length ?? 0) > 0) {
      const [sx, sy] = startKey.split(",").map(Number);
      const first: Point = { x: sx, y: sy };
      const loop: Point[] = [];
      let cursor = first;
      for (let step = 0; step < maxSteps; step++) {
        const list = outgoing.get(key(cursor));
        if (!list || list.length === 0) break;
        loop.push(cursor);
        cursor = list.shift()!;
        if (key(cursor) === key(first)) break;
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

/** Drop vertices that sit mid-way along a straight run. */
function dropCollinear(loop: readonly Point[]): Point[] {
  const n = loop.length;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const cur = loop[i];
    const next = loop[(i + 1) % n];
    const turns =
      Math.abs((cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x)) > 1e-6;
    if (turns) out.push(cur);
  }
  return out;
}

/**
 * One loop → a rounded SVG subpath.
 *
 * Each corner is a quadratic curve with the corner itself as the control point,
 * so the radius shrinks automatically on a short segment (`min(r, half the
 * shorter neighbour)`) — a narrow tray notch curves gently instead of
 * overshooting into a bowtie.
 */
function roundedSubpath(loop: readonly Point[], radius: number): string {
  const n = loop.length;
  if (n < 3) return "";
  const len = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
  const lerp = (from: Point, to: Point, d: number): Point => {
    const l = len(from, to) || 1;
    return { x: from.x + ((to.x - from.x) * d) / l, y: from.y + ((to.y - from.y) * d) / l };
  };

  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const cur = loop[i];
    const next = loop[(i + 1) % n];
    const r = Math.min(radius, len(prev, cur) / 2, len(cur, next) / 2);
    const from = lerp(cur, prev, r);
    const to = lerp(cur, next, r);
    if (i === 0) parts.push(`M ${from.x} ${from.y}`);
    else parts.push(`L ${from.x} ${from.y}`);
    parts.push(`Q ${cur.x} ${cur.y} ${to.x} ${to.y}`);
  }
  parts.push("Z");
  return parts.join(" ");
}

/**
 * The outline(s) hugging `boxes`, or null if there's nothing to draw.
 *
 * @param inset how far outside each box the outline runs
 * @param radius corner radius, shrunk per-corner where a segment is too short
 */
export function hullAround(
  boxes: readonly Box[],
  inset: number,
  radius: number,
): Hull | null {
  const usable = boxes.filter((b) => b.w > 0 && b.h > 0);
  if (usable.length === 0) return null;
  const padded = usable.map((b) => pad(b, inset));

  const loops = unionLoops(padded).map((l) => dropCollinear(l)).filter((l) => l.length >= 4);
  if (loops.length === 0) return null;

  const path = loops.map((l) => roundedSubpath(l, radius)).filter(Boolean).join(" ");
  if (!path) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of padded) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { path, x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
