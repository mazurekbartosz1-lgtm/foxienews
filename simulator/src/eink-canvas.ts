export const EPD_WIDTH = 200;
export const EPD_HEIGHT = 200;
export const EPD_BUFFER_BYTES = (EPD_WIDTH * EPD_HEIGHT) / 8; // 5000 bytes

const PAPER_RGB: [number, number, number] = [244, 243, 238];
const INK_RGB: [number, number, number] = [17, 17, 17];

export interface RenderOptions {
  inverted?: boolean;
  allBlack?: boolean;
}

/**
 * 1-bit monochrome bitmap in MSB-first row-major format
 * matching Adafruit_GFX / GxEPD2::drawBitmap.
 */
export class Bitmap1Bit {
  readonly width: number;
  readonly height: number;
  readonly bytesPerRow: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number, data?: Uint8Array) {
    this.width = width;
    this.height = height;
    this.bytesPerRow = Math.ceil(width / 8);
    this.data = data ?? new Uint8Array(this.bytesPerRow * height);
  }

  static fromAsciiArt(rows: readonly string[], scale = 1): Bitmap1Bit {
    const srcHeight = rows.length;
    const srcWidth = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const bmp = new Bitmap1Bit(srcWidth * scale, srcHeight * scale);

    for (let sy = 0; sy < srcHeight; sy++) {
      const row = rows[sy];
      for (let sx = 0; sx < srcWidth; sx++) {
        const ch = row[sx] ?? ".";
        const ink = ch === "#" || ch === "X" || ch === "1";
        if (!ink) continue;

        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            bmp.setPixel(sx * scale + dx, sy * scale + dy, true);
          }
        }
      }
    }

    return bmp;
  }

  getPixel(x: number, y: number): boolean {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return false;
    }
    const byteIndex = y * this.bytesPerRow + (x >> 3);
    const bitMask = 0x80 >> (x & 7);
    return (this.data[byteIndex] & bitMask) !== 0;
  }

  setPixel(x: number, y: number, ink = true): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return;
    }
    const byteIndex = y * this.bytesPerRow + (x >> 3);
    const bitMask = 0x80 >> (x & 7);
    if (ink) {
      this.data[byteIndex] |= bitMask;
    } else {
      this.data[byteIndex] &= ~bitMask;
    }
  }

  toCppProgmemArray(symbolName: string, comment?: string): string {
    return formatBytesAsCppProgmem(
      this.data,
      symbolName,
      comment ?? `${this.width}x${this.height} px, 1-bit MSB-first (${this.data.length} bytes)`,
    );
  }
}

export function formatBytesAsCppProgmem(
  bytes: Uint8Array,
  symbolName: string,
  comment: string,
): string {
  const lines: string[] = [
    `// ${comment}`,
    `const uint8_t ${symbolName}[${bytes.length}] PROGMEM = {`,
  ];

  for (let i = 0; i < bytes.length; i += 16) {
    const slice = Array.from(bytes.subarray(i, i + 16))
      .map((byte) => `0x${byte.toString(16).padStart(2, "0")}`)
      .join(", ");
    const trailingComma = i + 16 < bytes.length ? "," : "";
    lines.push(`  ${slice}${trailingComma}`);
  }

  lines.push("};");
  return lines.join("\n");
}

/**
 * 1-bit monochrome framebuffer matching Waveshare / GxEPD2 drawBitmap layout:
 * 200x200 px, row-major, MSB-first, 1 = black ink.
 */
export class EinkFramebuffer {
  readonly width = EPD_WIDTH;
  readonly height = EPD_HEIGHT;
  readonly buffer = new Uint8Array(EPD_BUFFER_BYTES);

  clear(ink = false): void {
    this.buffer.fill(ink ? 0xff : 0x00);
  }

  invert(): void {
    for (let i = 0; i < this.buffer.length; i++) {
      this.buffer[i] ^= 0xff;
    }
  }

  setPixel(x: number, y: number, ink = true): void {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || ix >= this.width || iy < 0 || iy >= this.height) {
      return;
    }
    const byteIndex = iy * (this.width / 8) + (ix >> 3);
    const bitMask = 0x80 >> (ix & 7);
    if (ink) {
      this.buffer[byteIndex] |= bitMask;
    } else {
      this.buffer[byteIndex] &= ~bitMask;
    }
  }

  getPixel(x: number, y: number): boolean {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return false;
    }
    const byteIndex = y * (this.width / 8) + (x >> 3);
    const bitMask = 0x80 >> (x & 7);
    return (this.buffer[byteIndex] & bitMask) !== 0;
  }

  drawHLine(x: number, y: number, w: number, ink = true): void {
    for (let i = 0; i < w; i++) {
      this.setPixel(x + i, y, ink);
    }
  }

  drawVLine(x: number, y: number, h: number, ink = true): void {
    for (let j = 0; j < h; j++) {
      this.setPixel(x, y + j, ink);
    }
  }

  drawRect(x: number, y: number, w: number, h: number, ink = true): void {
    if (w <= 0 || h <= 0) return;
    this.drawHLine(x, y, w, ink);
    this.drawHLine(x, y + h - 1, w, ink);
    this.drawVLine(x, y, h, ink);
    this.drawVLine(x + w - 1, y, h, ink);
  }

  fillRect(x: number, y: number, w: number, h: number, ink = true): void {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        this.setPixel(x + i, y + j, ink);
      }
    }
  }

  drawRoundedRect(x: number, y: number, w: number, h: number, ink = true): void {
    if (w < 4 || h < 4) {
      this.drawRect(x, y, w, h, ink);
      return;
    }
    this.drawHLine(x + 1, y, w - 2, ink);
    this.drawHLine(x + 1, y + h - 1, w - 2, ink);
    this.drawVLine(x, y + 1, h - 2, ink);
    this.drawVLine(x + w - 1, y + 1, h - 2, ink);
  }

  drawBitmap(x: number, y: number, bmp: Bitmap1Bit, invert = false): void {
    for (let by = 0; by < bmp.height; by++) {
      for (let bx = 0; bx < bmp.width; bx++) {
        const px = bmp.getPixel(bx, by);
        if (px) {
          this.setPixel(x + bx, y + by, !invert);
        }
      }
    }
  }

  renderToCanvas(canvas: HTMLCanvasElement, options: RenderOptions = {}): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const imageData = ctx.createImageData(this.width, this.height);
    const data = imageData.data;

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        let isInk = options.allBlack ? true : this.getPixel(x, y);
        if (options.inverted && !options.allBlack) {
          isInk = !isInk;
        }
        const [r, g, b] = isInk ? INK_RGB : PAPER_RGB;
        const offset = (y * this.width + x) * 4;
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
        data[offset + 3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  toCppProgmemArray(symbolName: string): string {
    return formatBytesAsCppProgmem(
      this.buffer,
      symbolName,
      `${this.width}x${this.height} px, 1-bit MSB-first (${this.buffer.length} bytes)`,
    );
  }
}
