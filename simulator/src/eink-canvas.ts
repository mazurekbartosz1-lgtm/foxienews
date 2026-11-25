export const EPD_WIDTH = 200;
export const EPD_HEIGHT = 200;
export const EPD_BUFFER_BYTES = (EPD_WIDTH * EPD_HEIGHT) / 8; // 5000 bytes

const PAPER_RGB: [number, number, number] = [244, 243, 238];
const INK_RGB: [number, number, number] = [17, 17, 17];

/**
 * 1-bit monochrome framebuffer matching Waveshare / GxEPD2 drawBitmap layout:
 * row-major, MSB-first (bit 7 = leftmost pixel of the 8-pixel byte), 1 = black ink.
 */
export class EinkFramebuffer {
  readonly width = EPD_WIDTH;
  readonly height = EPD_HEIGHT;
  readonly buffer = new Uint8Array(EPD_BUFFER_BYTES);

  clear(ink = false): void {
    this.buffer.fill(ink ? 0xff : 0x00);
  }

  setPixel(x: number, y: number, ink = true): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return;
    }
    const byteIndex = y * (this.width / 8) + (x >> 3);
    const bitMask = 0x80 >> (x & 7);
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

  drawRect(x: number, y: number, w: number, h: number, ink = true): void {
    for (let i = 0; i < w; i++) {
      this.setPixel(x + i, y, ink);
      this.setPixel(x + i, y + h - 1, ink);
    }
    for (let j = 0; j < h; j++) {
      this.setPixel(x, y + j, ink);
      this.setPixel(x + w - 1, y + j, ink);
    }
  }

  renderToCanvas(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const imageData = ctx.createImageData(this.width, this.height);
    const data = imageData.data;

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const isInk = this.getPixel(x, y);
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

  /**
   * Formats the 1-bit framebuffer as a C++ PROGMEM byte array compatible with firmware/include/ui_assets.h.
   */
  toCppProgmemArray(symbolName: string): string {
    const lines: string[] = [
      `// ${this.width}x${this.height} px, 1-bit MSB-first (${this.buffer.length} bytes)`,
      `const uint8_t ${symbolName}[${this.buffer.length}] PROGMEM = {`,
    ];

    for (let i = 0; i < this.buffer.length; i += 16) {
      const slice = Array.from(this.buffer.subarray(i, i + 16))
        .map((byte) => `0x${byte.toString(16).padStart(2, "0")}`)
        .join(", ");
      const trailingComma = i + 16 < this.buffer.length ? "," : "";
      lines.push(`  ${slice}${trailingComma}`);
    }

    lines.push("};");
    return lines.join("\n");
  }
}
