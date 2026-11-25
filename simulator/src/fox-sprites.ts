import { Bitmap1Bit } from "./eink-canvas.ts";
import {
  drawLine,
  fillCircle,
  fillPolygon,
  fillRect,
  fillRoundedRect,
  sampleCubicBezier,
  strokeCircle,
  strokePolygon,
  strokeRoundedRect,
  type Point2D,
} from "./vector-1bit.ts";

export interface SpriteAssetEntry {
  symbol: string;
  bitmap: Bitmap1Bit;
  description: string;
}

export const UI_LAYOUT = {
  STATUS_BAR_H: 22,
  FOX_W: 192,
  FOX_H: 136,
  FOX_X: 4,
  FOX_Y: 26,
  FOX_READY_Y: 40,
  TITLE_Y: 170,
  PROGRESS_Y: 174,
  QR_X: 56,
  QR_Y: 50,
  QR_SIZE: 87,
  PEEK_X: 72,
  PEEK_Y: 26,
} as const;

type DeskFoxVariant = "sleep" | "listen" | "upload" | "saved" | "error";

/**
 * Renders the geometric desk fox adapted directly from CompanionDesk.tsx
 * (viewBox 0 0 180 135) onto a crisp 1-bit 192x136 sprite.
 */
function renderDeskFoxScene(variant: DeskFoxVariant): Bitmap1Bit {
  const bmp = new Bitmap1Bit(UI_LAYOUT.FOX_W, UI_LAYOUT.FOX_H);
  const scale = 1.18;
  const ox = 96 - 90 * scale;
  const oy = 3 - 14 * scale;

  const sx = (x: number): number => x * scale + ox;
  const sy = (y: number): number => y * scale + oy;
  const sw = (v: number): number => v * scale;
  const pts = (coords: readonly [number, number][]): Point2D[] =>
    coords.map(([x, y]) => ({ x: sx(x), y: sy(y) }));

  // 1. Bushy tail peeking on the right of torso
  const tailCurveA = sampleCubicBezier(
    { x: sx(110), y: sy(80) },
    { x: sx(122), y: sy(76) },
    { x: sx(128), y: sy(66) },
    { x: sx(126), y: sy(58) },
    12,
  );
  const tailCurveB = sampleCubicBezier(
    { x: sx(126), y: sy(58) },
    { x: sx(122), y: sy(66) },
    { x: sx(116), y: sy(72) },
    { x: sx(110), y: sy(74) },
    12,
  );
  const tailPoly = [...tailCurveA, ...tailCurveB.slice(1)];
  fillPolygon(bmp, tailPoly, "fur");
  fillPolygon(bmp, pts([[126, 58], [122, 66], [125, 64]]), "white");
  strokePolygon(bmp, tailPoly, 1.8, true);

  // 2. Tall alert triangular ears with black tips & white inner triangles
  const leftEar = pts([[68, 34], [73, 14], [83, 33]]);
  fillPolygon(bmp, leftEar, "fur");
  fillPolygon(bmp, pts([[71, 21], [73, 14], [77, 21]]), "black");
  fillPolygon(bmp, pts([[72, 32], [75, 23], [80, 32]]), "white");
  strokePolygon(bmp, leftEar, 1.9, true);

  const rightEar = pts([[97, 33], [107, 14], [112, 34]]);
  fillPolygon(bmp, rightEar, "fur");
  fillPolygon(bmp, pts([[103, 21], [107, 14], [109, 21]]), "black");
  fillPolygon(bmp, pts([[100, 32], [105, 23], [108, 32]]), "white");
  strokePolygon(bmp, rightEar, 1.9, true);

  // 3. Torso & white chest bib
  fillRoundedRect(bmp, sx(70), sy(62), sw(40), sw(34), sw(4), "fur");
  strokeRoundedRect(bmp, sx(70), sy(62), sw(40), sw(34), sw(4), 1.9, true);
  const chestBib = pts([[78, 92], [90, 66], [102, 92]]);
  fillPolygon(bmp, chestBib, "white");
  strokePolygon(bmp, chestBib, 1.6, true);

  // 4. Boxy rounded head, white cheek triangles & black nose
  fillRoundedRect(bmp, sx(67), sy(33), sw(46), sw(32), sw(5), "fur");
  strokeRoundedRect(bmp, sx(67), sy(33), sw(46), sw(32), sw(5), 1.9, true);
  const cheeks = pts([[67, 61], [80, 48], [90, 62], [100, 48], [113, 61]]);
  fillPolygon(bmp, cheeks, "white");
  strokePolygon(bmp, cheeks, 1.7, true);
  fillCircle(bmp, sx(90), sy(53), sw(2.3), "black");

  // 5. Eyes per state
  const leftEyeX = sx(79);
  const rightEyeX = sx(101);
  const eyeY = sy(43);
  const eyeR = sw(4.4);

  if (variant === "sleep") {
    drawLine(bmp, leftEyeX - 4, eyeY, leftEyeX + 4, eyeY, 2.0, true);
    drawLine(bmp, rightEyeX - 4, eyeY, rightEyeX + 4, eyeY, 2.0, true);
  } else if (variant === "listen" || variant === "upload") {
    const pupilOffsetY = variant === "upload" ? -2.0 : 0;
    fillCircle(bmp, leftEyeX, eyeY, eyeR, "white");
    strokeCircle(bmp, leftEyeX, eyeY, eyeR, 1.8, true);
    fillCircle(bmp, leftEyeX, eyeY + pupilOffsetY, eyeR * 0.45, "black");

    fillCircle(bmp, rightEyeX, eyeY, eyeR, "white");
    strokeCircle(bmp, rightEyeX, eyeY, eyeR, 1.8, true);
    fillCircle(bmp, rightEyeX, eyeY + pupilOffsetY, eyeR * 0.45, "black");
  } else if (variant === "saved") {
    drawLine(bmp, leftEyeX - 4, eyeY + 1.5, leftEyeX, eyeY - 2.5, 2.0, true);
    drawLine(bmp, leftEyeX, eyeY - 2.5, leftEyeX + 4, eyeY + 1.5, 2.0, true);
    drawLine(bmp, rightEyeX - 4, eyeY + 1.5, rightEyeX, eyeY - 2.5, 2.0, true);
    drawLine(bmp, rightEyeX, eyeY - 2.5, rightEyeX + 4, eyeY + 1.5, 2.0, true);
  } else {
    // error: X X eyes
    drawLine(bmp, leftEyeX - 3.5, eyeY - 3.5, leftEyeX + 3.5, eyeY + 3.5, 2.0, true);
    drawLine(bmp, leftEyeX + 3.5, eyeY - 3.5, leftEyeX - 3.5, eyeY + 3.5, 2.0, true);
    drawLine(bmp, rightEyeX - 3.5, eyeY - 3.5, rightEyeX + 3.5, eyeY + 3.5, 2.0, true);
    drawLine(bmp, rightEyeX + 3.5, eyeY - 3.5, rightEyeX - 3.5, eyeY + 3.5, 2.0, true);
  }

  // 6. Paws (typing offset when recording/listening)
  const leftPawY = variant === "listen" ? 81 : 86;
  const rightPawY = variant === "listen" ? 88 : 86;
  fillRoundedRect(bmp, sx(63), sy(leftPawY), sw(12), sw(9), sw(2), "fur");
  strokeRoundedRect(bmp, sx(63), sy(leftPawY), sw(12), sw(9), sw(2), 1.8, true);
  fillRoundedRect(bmp, sx(105), sy(rightPawY), sw(12), sw(9), sw(2), "fur");
  strokeRoundedRect(bmp, sx(105), sy(rightPawY), sw(12), sw(9), sw(2), 1.8, true);

  // 7. Typewriter (paper + black body + keybed strip + 5 keys)
  const paperX = variant === "listen" ? 77 : 75;
  fillRoundedRect(bmp, sx(paperX), sy(67), sw(30), sw(20), sw(1.5), "white");
  strokeRoundedRect(bmp, sx(paperX), sy(67), sw(30), sw(20), sw(1.5), 1.8, true);
  drawLine(bmp, sx(paperX + 4), sy(73), sx(paperX + 22), sy(73), 1.6, true);
  drawLine(bmp, sx(paperX + 4), sy(78), sx(paperX + 17), sy(78), 1.6, true);

  fillRoundedRect(bmp, sx(65), sy(84), sw(50), sw(15), sw(2.5), "black");
  fillRoundedRect(bmp, sx(72), sy(88), sw(36), sw(6), sw(1.5), "white");
  for (const kx of [78, 84, 90, 96, 102]) {
    fillCircle(bmp, sx(kx), sy(91), 1.5, "black");
  }

  // 8. Coffee mug on left of desk
  fillRoundedRect(bmp, sx(28), sy(85), sw(12), sw(14), sw(1.5), "white");
  strokeRoundedRect(bmp, sx(28), sy(85), sw(12), sw(14), sw(1.5), 1.8, true);
  drawLine(bmp, sx(28), sy(88), sx(24), sy(88), 1.7, true);
  drawLine(bmp, sx(24), sy(88), sx(24), sy(94), 1.7, true);
  drawLine(bmp, sx(24), sy(94), sx(28), sy(94), 1.7, true);

  // 9. Desk surface, legs & subtle floor baseline
  fillRoundedRect(bmp, sx(14), sy(99), sw(152), sw(7), sw(1.5), "white");
  strokeRoundedRect(bmp, sx(14), sy(99), sw(152), sw(7), sw(1.5), 2.0, true);
  drawLine(bmp, sx(28), sy(106), sx(28), sy(124), 2.2, true);
  drawLine(bmp, sx(152), sy(106), sx(152), sy(124), 2.2, true);
  drawLine(bmp, sx(12), sy(124), sx(168), sy(124), 1.4, true);

  // 10. State-specific overlays
  if (variant === "sleep") {
    // Floating "z Z" above right ear + mug steam
    drawLine(bmp, sx(121), sy(26), sx(127), sy(26), 1.7, true);
    drawLine(bmp, sx(127), sy(26), sx(121), sy(32), 1.7, true);
    drawLine(bmp, sx(121), sy(32), sx(127), sy(32), 1.7, true);

    drawLine(bmp, sx(132), sy(16), sx(140), sy(16), 1.9, true);
    drawLine(bmp, sx(140), sy(16), sx(132), sy(24), 1.9, true);
    drawLine(bmp, sx(132), sy(24), sx(140), sy(24), 1.9, true);

    drawLine(bmp, sx(33), sy(78), sx(35), sy(73), 1.4, true);
    drawLine(bmp, sx(37), sy(80), sx(39), sy(75), 1.4, true);
  } else if (variant === "listen") {
    // Crisp sound wave arcs on both sides of head
    drawLine(bmp, sx(57), sy(34), sx(54), sy(43), 1.8, true);
    drawLine(bmp, sx(54), sy(43), sx(57), sy(52), 1.8, true);
    drawLine(bmp, sx(50), sy(30), sx(46), sy(43), 1.8, true);
    drawLine(bmp, sx(46), sy(43), sx(50), sy(56), 1.8, true);

    drawLine(bmp, sx(123), sy(34), sx(126), sy(43), 1.8, true);
    drawLine(bmp, sx(126), sy(43), sx(123), sy(52), 1.8, true);
    drawLine(bmp, sx(130), sy(30), sx(134), sy(43), 1.8, true);
    drawLine(bmp, sx(134), sy(43), sx(130), sy(56), 1.8, true);
  } else if (variant === "upload") {
    // Bold upward arrow in upper right
    drawLine(bmp, sx(138), sy(40), sx(138), sy(18), 2.5, true);
    drawLine(bmp, sx(138), sy(18), sx(131), sy(26), 2.5, true);
    drawLine(bmp, sx(138), sy(18), sx(145), sy(26), 2.5, true);
  } else if (variant === "saved") {
    // Seal stamp on right of desk + checkmark badge
    fillCircle(bmp, sx(144), sy(93), sw(5.5), "fur");
    strokeCircle(bmp, sx(144), sy(93), sw(5.5), 1.8, true);

    fillCircle(bmp, sx(139), sy(26), 13, "white");
    strokeCircle(bmp, sx(139), sy(26), 13, 1.9, true);
    drawLine(bmp, sx(133), sy(26), sx(137), sy(31), 2.2, true);
    drawLine(bmp, sx(137), sy(31), sx(145), sy(21), 2.2, true);
  } else if (variant === "error") {
    // Alert badge (!) in upper right
    fillCircle(bmp, sx(139), sy(26), 13, "white");
    strokeCircle(bmp, sx(139), sy(26), 13, 1.9, true);
    drawLine(bmp, sx(139), sy(19), sx(139), sy(27), 2.4, true);
    fillCircle(bmp, sx(139), sy(32), 1.7, "black");
  }

  return bmp;
}

/**
 * Peeking geometric CompanionDesk fox ears + eyes above the Wi-Fi QR frame (56x22 px).
 */
function renderPeekFox(): Bitmap1Bit {
  const bmp = new Bitmap1Bit(56, 22);
  const scale = 0.62;
  const ox = 28 - 90 * scale;
  const oy = 1 - 14 * scale;

  const sx = (x: number): number => x * scale + ox;
  const sy = (y: number): number => y * scale + oy;
  const pts = (coords: readonly [number, number][]): Point2D[] =>
    coords.map(([x, y]) => ({ x: sx(x), y: sy(y) }));

  const leftEar = pts([[68, 34], [73, 14], [83, 33]]);
  fillPolygon(bmp, leftEar, "fur");
  fillPolygon(bmp, pts([[71, 21], [73, 14], [77, 21]]), "black");
  fillPolygon(bmp, pts([[72, 32], [75, 23], [80, 32]]), "white");
  strokePolygon(bmp, leftEar, 1.3, true);

  const rightEar = pts([[97, 33], [107, 14], [112, 34]]);
  fillPolygon(bmp, rightEar, "fur");
  fillPolygon(bmp, pts([[103, 21], [107, 14], [109, 21]]), "black");
  fillPolygon(bmp, pts([[100, 32], [105, 23], [108, 32]]), "white");
  strokePolygon(bmp, rightEar, 1.3, true);

  // Top half of boxy head peeking up
  fillRoundedRect(bmp, sx(67), sy(33), 46 * scale, 18, 3, "fur");
  strokeRoundedRect(bmp, sx(67), sy(33), 46 * scale, 18, 3, 1.3, true);

  // Big round googly eyes
  const eyeY = sy(43);
  const eyeR = 4.3 * scale;
  fillCircle(bmp, sx(79), eyeY, eyeR, "white");
  strokeCircle(bmp, sx(79), eyeY, eyeR, 1.2, true);
  fillCircle(bmp, sx(79), eyeY, eyeR * 0.45, "black");

  fillCircle(bmp, sx(101), eyeY, eyeR, "white");
  strokeCircle(bmp, sx(101), eyeY, eyeR, 1.2, true);
  fillCircle(bmp, sx(101), eyeY, eyeR * 0.45, "black");

  // Clean flat bottom edge where it rests on the QR frame
  fillRect(bmp, 0, 21, 56, 1, "black");
  return bmp;
}

// 16x16 crisp status icons (32 bytes each)
const ICON_WIFI_ON_ART = [
  "................",
  "....########....",
  "..##........##..",
  ".#............#.",
  "....########....",
  "..##........##..",
  "......####......",
  "....##....##....",
  ".......##.......",
  ".......##.......",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
] as const;

const ICON_WIFI_OFF_ART = [
  "...........##...",
  "....######.##...",
  "..##......##....",
  ".#.......##...#.",
  "....####.##.....",
  "..##....##..##..",
  ".......##.##....",
  ".....###..##....",
  "....##.##.......",
  "...##..##.......",
  "..##............",
  "................",
  "................",
  "................",
  "................",
  "................",
] as const;

const ICON_MIC_ART = [
  "......####......",
  ".....######.....",
  ".....######.....",
  ".....######.....",
  ".....######.....",
  ".....######.....",
  "...#..####..#...",
  "...#........#...",
  "....#......#....",
  ".....######.....",
  ".......##.......",
  ".......##.......",
  "....########....",
  "................",
  "................",
  "................",
] as const;

const ICON_CHECK_ART = [
  "................",
  "................",
  ".............##.",
  "............###.",
  "...........###..",
  "..........###...",
  "..#......###....",
  "..##....###.....",
  "...##..###......",
  "....#####.......",
  ".....###........",
  "......#.........",
  "................",
  "................",
  "................",
  "................",
] as const;

const ICON_ALERT_ART = [
  ".......##.......",
  "......####......",
  "......####......",
  ".....##..##.....",
  ".....##..##.....",
  "....##.##.##....",
  "....##.##.##....",
  "...###.##.###...",
  "...###.##.###...",
  "..####.##.####..",
  "..############..",
  ".#####.##.#####.",
  ".#####.##.#####.",
  "################",
  "................",
  "................",
] as const;

export const FOX_SPRITE_SLEEP = renderDeskFoxScene("sleep");
export const FOX_SPRITE_LISTEN = renderDeskFoxScene("listen");
export const FOX_SPRITE_UPLOAD = renderDeskFoxScene("upload");
export const FOX_SPRITE_SAVED = renderDeskFoxScene("saved");
export const FOX_SPRITE_ERROR = renderDeskFoxScene("error");
export const FOX_SPRITE_PEEK = renderPeekFox();

export const ICON_WIFI_ON = Bitmap1Bit.fromAsciiArt(ICON_WIFI_ON_ART, 1);
export const ICON_WIFI_OFF = Bitmap1Bit.fromAsciiArt(ICON_WIFI_OFF_ART, 1);
export const ICON_MIC = Bitmap1Bit.fromAsciiArt(ICON_MIC_ART, 1);
export const ICON_CHECK = Bitmap1Bit.fromAsciiArt(ICON_CHECK_ART, 1);
export const ICON_ALERT = Bitmap1Bit.fromAsciiArt(ICON_ALERT_ART, 1);

export const FOX_ASSET_REGISTRY: readonly SpriteAssetEntry[] = [
  {
    symbol: "FOX_SPRITE_SLEEP",
    bitmap: FOX_SPRITE_SLEEP,
    description: "Gotowy / Uśpiony lisek przy biurku (192x136 px)",
  },
  {
    symbol: "FOX_SPRITE_LISTEN",
    bitmap: FOX_SPRITE_LISTEN,
    description: "Nagrywanie / Lisek piszący przy biurku (192x136 px)",
  },
  {
    symbol: "FOX_SPRITE_UPLOAD",
    bitmap: FOX_SPRITE_UPLOAD,
    description: "Wysyłanie nagrania z maszyny (192x136 px)",
  },
  {
    symbol: "FOX_SPRITE_SAVED",
    bitmap: FOX_SPRITE_SAVED,
    description: "Zapisano / Pieczęć na biurku (192x136 px)",
  },
  {
    symbol: "FOX_SPRITE_ERROR",
    bitmap: FOX_SPRITE_ERROR,
    description: "Błąd urządzenia / sieci (192x136 px)",
  },
  {
    symbol: "FOX_SPRITE_PEEK",
    bitmap: FOX_SPRITE_PEEK,
    description: "Wyglądający lisek nad kodem QR Wi-Fi (56x22 px)",
  },
  {
    symbol: "ICON_WIFI_ON",
    bitmap: ICON_WIFI_ON,
    description: "Ikona Wi-Fi połączone (16x16 px)",
  },
  {
    symbol: "ICON_WIFI_OFF",
    bitmap: ICON_WIFI_OFF,
    description: "Ikona Wi-Fi rozłączone (16x16 px)",
  },
  {
    symbol: "ICON_MIC",
    bitmap: ICON_MIC,
    description: "Ikona mikrofonu (16x16 px)",
  },
  {
    symbol: "ICON_CHECK",
    bitmap: ICON_CHECK,
    description: "Ikona sukcesu (16x16 px)",
  },
  {
    symbol: "ICON_ALERT",
    bitmap: ICON_ALERT,
    description: "Ikona ostrzeżenia / błędu (16x16 px)",
  },
];
