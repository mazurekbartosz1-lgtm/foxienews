import type { Bitmap1Bit } from "./eink-canvas.ts";

export type FillPattern = "black" | "white" | "fur" | "desk";

export interface Point2D {
  x: number;
  y: number;
}

function matchesPattern(x: number, y: number, pattern: FillPattern): boolean | null {
  switch (pattern) {
    case "black":
      return true;
    case "white":
      return false;
    case "fur":
      // Crisp 25% stipple representing warm orange fox fur on 1-bit e-paper
      return (x & 1) === 0 && (y & 1) === 0;
    case "desk":
      // Light 12.5% stipple for desk surface contrast
      return (x & 3) === 0 && (y & 3) === 0;
  }
}

export function plotPatternPixel(
  bmp: Bitmap1Bit,
  x: number,
  y: number,
  pattern: FillPattern,
): void {
  const ix = Math.round(x);
  const iy = Math.round(y);
  const ink = matchesPattern(ix, iy, pattern);
  if (ink !== null) {
    bmp.setPixel(ix, iy, ink);
  }
}

export function drawLine(
  bmp: Bitmap1Bit,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness = 1.5,
  ink = true,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist * 2));
  const r = Math.max(0.45, thickness / 2);
  const r2 = r * r;
  const ir = Math.ceil(r);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = x0 + dx * t;
    const cy = y0 + dy * t;

    if (thickness <= 1.2) {
      bmp.setPixel(Math.round(cx), Math.round(cy), ink);
      continue;
    }

    for (let oy = -ir; oy <= ir; oy++) {
      for (let ox = -ir; ox <= ir; ox++) {
        const px = Math.round(cx + ox);
        const py = Math.round(cy + oy);
        const ddx = px - cx;
        const ddy = py - cy;
        if (ddx * ddx + ddy * ddy <= r2 + 0.15) {
          bmp.setPixel(px, py, ink);
        }
      }
    }
  }
}

export function fillRect(
  bmp: Bitmap1Bit,
  x: number,
  y: number,
  w: number,
  h: number,
  pattern: FillPattern,
): void {
  const xStart = Math.round(x);
  const yStart = Math.round(y);
  const xEnd = Math.round(x + w);
  const yEnd = Math.round(y + h);

  for (let py = yStart; py < yEnd; py++) {
    for (let px = xStart; px < xEnd; px++) {
      plotPatternPixel(bmp, px, py, pattern);
    }
  }
}

function insideRoundedRect(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
): boolean {
  const r = Math.min(rx, w / 2, h / 2);
  if (px < x || px > x + w || py < y || py > y + h) return false;
  if (px >= x + r && px <= x + w - r) return true;
  if (py >= y + r && py <= y + h - r) return true;

  const cx = px < x + r ? x + r : x + w - r;
  const cy = py < y + r ? y + r : y + h - r;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r + 0.15;
}

export function fillRoundedRect(
  bmp: Bitmap1Bit,
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
  pattern: FillPattern,
): void {
  const xStart = Math.floor(x);
  const yStart = Math.floor(y);
  const xEnd = Math.ceil(x + w);
  const yEnd = Math.ceil(y + h);

  for (let py = yStart; py <= yEnd; py++) {
    for (let px = xStart; px <= xEnd; px++) {
      if (insideRoundedRect(px, py, x, y, w, h, rx)) {
        plotPatternPixel(bmp, px, py, pattern);
      }
    }
  }
}

export function strokeRoundedRect(
  bmp: Bitmap1Bit,
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
  thickness = 1.5,
  ink = true,
): void {
  const r = Math.min(rx, w / 2, h / 2);
  const half = Math.max(0.5, thickness / 2);
  const xStart = Math.floor(x - half - 1);
  const yStart = Math.floor(y - half - 1);
  const xEnd = Math.ceil(x + w + half + 1);
  const yEnd = Math.ceil(y + h + half + 1);

  for (let py = yStart; py <= yEnd; py++) {
    for (let px = xStart; px <= xEnd; px++) {
      const outer = insideRoundedRect(
        px,
        py,
        x - half,
        y - half,
        w + half * 2,
        h + half * 2,
        r + half,
      );
      const inner = insideRoundedRect(
        px,
        py,
        x + half,
        y + half,
        Math.max(0, w - half * 2),
        Math.max(0, h - half * 2),
        Math.max(0, r - half),
      );
      if (outer && !inner) {
        bmp.setPixel(px, py, ink);
      }
    }
  }
}

export function fillPolygon(
  bmp: Bitmap1Bit,
  points: readonly Point2D[],
  pattern: FillPattern,
): void {
  if (points.length < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const yStart = Math.floor(minY);
  const yEnd = Math.ceil(maxY);

  for (let py = yStart; py <= yEnd; py++) {
    const scanY = py + 0.01;
    const intersections: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if ((a.y <= scanY && b.y > scanY) || (b.y <= scanY && a.y > scanY)) {
        const ix = a.x + ((scanY - a.y) * (b.x - a.x)) / (b.y - a.y);
        intersections.push(ix);
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const x0 = Math.round(intersections[i]);
      const x1 = Math.round(intersections[i + 1]);
      for (let px = x0; px <= x1; px++) {
        plotPatternPixel(bmp, px, py, pattern);
      }
    }
  }
}

export function strokePolygon(
  bmp: Bitmap1Bit,
  points: readonly Point2D[],
  thickness = 1.5,
  ink = true,
): void {
  if (points.length < 2) return;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    drawLine(bmp, a.x, a.y, b.x, b.y, thickness, ink);
  }
}

export function fillCircle(
  bmp: Bitmap1Bit,
  cx: number,
  cy: number,
  r: number,
  pattern: FillPattern,
): void {
  const ir = Math.ceil(r + 1);
  const r2 = r * r;
  for (let oy = -ir; oy <= ir; oy++) {
    for (let ox = -ir; ox <= ir; ox++) {
      const px = Math.round(cx + ox);
      const py = Math.round(cy + oy);
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= r2 + 0.25) {
        plotPatternPixel(bmp, px, py, pattern);
      }
    }
  }
}

export function strokeCircle(
  bmp: Bitmap1Bit,
  cx: number,
  cy: number,
  r: number,
  thickness = 1.5,
  ink = true,
): void {
  const half = Math.max(0.5, thickness / 2);
  const outer2 = (r + half) * (r + half);
  const inner = Math.max(0, r - half);
  const inner2 = inner * inner;
  const bound = Math.ceil(r + half + 1);

  for (let oy = -bound; oy <= bound; oy++) {
    for (let ox = -bound; ox <= bound; ox++) {
      const px = Math.round(cx + ox);
      const py = Math.round(cy + oy);
      const dx = px - cx;
      const dy = py - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= outer2 + 0.15 && d2 >= inner2 - 0.15) {
        bmp.setPixel(px, py, ink);
      }
    }
  }
}

export function sampleCubicBezier(
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  steps = 12,
): Point2D[] {
  const out: Point2D[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push({
      x:
        u * u * u * p0.x +
        3 * u * u * t * p1.x +
        3 * u * t * t * p2.x +
        t * t * t * p3.x,
      y:
        u * u * u * p0.y +
        3 * u * u * t * p1.y +
        3 * u * t * t * p2.y +
        t * t * t * p3.y,
    });
  }
  return out;
}
