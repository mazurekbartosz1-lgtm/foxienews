import qrcode from "qrcode-generator";
import { drawText, drawTextCentered } from "./bitmap-font.ts";
import { EPD_HEIGHT, EPD_WIDTH, type EinkFramebuffer } from "./eink-canvas.ts";
import {
  FOX_SPRITE_ERROR,
  FOX_SPRITE_LISTEN,
  FOX_SPRITE_PEEK,
  FOX_SPRITE_SAVED,
  FOX_SPRITE_SLEEP,
  FOX_SPRITE_UPLOAD,
  ICON_MIC,
  ICON_WIFI_OFF,
  ICON_WIFI_ON,
  UI_LAYOUT,
} from "./fox-sprites.ts";

export type DeviceState =
  | "ready"
  | "recording"
  | "uploading"
  | "saved"
  | "error"
  | "wifi";

export interface ScreenContext {
  state: DeviceState;
  wifiConnected: boolean;
  batteryPercent: number;
  recordingSeconds: number;
  audioLevel: number;
  uploadStep: string;
  uploadProgress: number;
  savedTitle: string;
  errorMessage: string;
  apSsid: string;
  apPassword: string;
  sleeping: boolean;
}

function drawBatteryIcon(
  fb: EinkFramebuffer,
  x: number,
  y: number,
  percent: number,
): void {
  const clamped = Math.max(0, Math.min(100, percent));
  fb.drawRect(x, y, 20, 10, true);
  fb.fillRect(x + 20, y + 3, 2, 4, true);
  const fillW = Math.round((clamped / 100) * 16);
  if (fillW > 0) {
    fb.fillRect(x + 2, y + 2, fillW, 6, true);
  }
}

function getStatusLabel(ctx: ScreenContext): string {
  if (ctx.sleeping) return "UŚPIONY";
  switch (ctx.state) {
    case "ready":
      return ctx.wifiConnected ? "POŁĄCZONY" : "BRAK WI-FI";
    case "recording":
      return "NAGRYWANIE";
    case "uploading":
      return "WYSYŁANIE";
    case "saved":
      return "ZAPISANO";
    case "error":
      return "BŁĄD";
    case "wifi":
      return "WI-FI AP";
  }
}

function drawStatusBar(fb: EinkFramebuffer, ctx: ScreenContext): void {
  const wifiIcon = ctx.wifiConnected ? ICON_WIFI_ON : ICON_WIFI_OFF;
  fb.drawBitmap(6, 3, wifiIcon);

  drawText(fb, 26, 7, getStatusLabel(ctx), 1, true);

  const batText = `${Math.round(ctx.batteryPercent)}%`;
  drawText(fb, 144, 7, batText, 1, true);
  drawBatteryIcon(fb, 172, 6, ctx.batteryPercent);

  fb.drawHLine(0, UI_LAYOUT.STATUS_BAR_H, EPD_WIDTH, true);
}

function formatDuration(totalSec: number): string {
  const min = Math.floor(totalSec / 60);
  const sec = Math.floor(totalSec % 60);
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function drawProgressBar(
  fb: EinkFramebuffer,
  x: number,
  y: number,
  w: number,
  h: number,
  percent: number,
): void {
  fb.drawRect(x, y, w, h, true);
  const innerW = Math.max(0, Math.round(((w - 4) * Math.min(100, percent)) / 100));
  if (innerW > 0) {
    fb.fillRect(x + 2, y + 2, innerW, h - 4, true);
  }
}

function drawWifiQr(fb: EinkFramebuffer, ctx: ScreenContext): void {
  const ssid = ctx.apSsid.trim() || "Foxie-Setup";
  const pass = ctx.apPassword.trim();
  const payload = pass
    ? `WIFI:T:WPA;S:${ssid};P:${pass};;`
    : `WIFI:T:nopass;S:${ssid};;`;

  const qr = qrcode(0, "M");
  qr.addData(payload);
  qr.make();

  const modules = qr.getModuleCount();
  const maxBox = UI_LAYOUT.QR_SIZE;
  const cellSize = Math.max(2, Math.floor(maxBox / modules));
  const totalPx = modules * cellSize;
  const originX = Math.round((EPD_WIDTH - totalPx) / 2);
  const originY = UI_LAYOUT.QR_Y;

  fb.drawRoundedRect(originX - 4, originY - 4, totalPx + 8, totalPx + 8, true);

  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (qr.isDark(r, c)) {
        fb.fillRect(
          originX + c * cellSize,
          originY + r * cellSize,
          cellSize,
          cellSize,
          true,
        );
      }
    }
  }
}

export function renderDeviceScreen(
  fb: EinkFramebuffer,
  ctx: ScreenContext,
): void {
  fb.clear(false);
  drawStatusBar(fb, ctx);

  switch (ctx.state) {
    case "ready": {
      // Minimalist screen: large sleeping desk fox filling most of the canvas
      fb.drawBitmap(UI_LAYOUT.FOX_X, UI_LAYOUT.FOX_READY_Y, FOX_SPRITE_SLEEP);
      break;
    }

    case "recording": {
      fb.drawBitmap(UI_LAYOUT.FOX_X, UI_LAYOUT.FOX_Y, FOX_SPRITE_LISTEN);
      fb.drawBitmap(10, 28, ICON_MIC);
      drawTextCentered(
        fb,
        EPD_WIDTH / 2,
        UI_LAYOUT.TITLE_Y,
        formatDuration(ctx.recordingSeconds),
        2,
      );
      break;
    }

    case "uploading": {
      fb.drawBitmap(UI_LAYOUT.FOX_X, UI_LAYOUT.FOX_Y, FOX_SPRITE_UPLOAD);
      drawProgressBar(fb, 28, UI_LAYOUT.PROGRESS_Y, 144, 12, ctx.uploadProgress);
      break;
    }

    case "saved": {
      fb.drawBitmap(UI_LAYOUT.FOX_X, UI_LAYOUT.FOX_Y, FOX_SPRITE_SAVED);
      drawTextCentered(fb, EPD_WIDTH / 2, UI_LAYOUT.TITLE_Y, "ZAPISANO!", 2);
      break;
    }

    case "error": {
      fb.drawBitmap(UI_LAYOUT.FOX_X, UI_LAYOUT.FOX_Y, FOX_SPRITE_ERROR);
      drawTextCentered(fb, EPD_WIDTH / 2, UI_LAYOUT.TITLE_Y, "BŁĄD", 2);
      break;
    }

    case "wifi": {
      fb.drawBitmap(UI_LAYOUT.PEEK_X, UI_LAYOUT.PEEK_Y, FOX_SPRITE_PEEK);
      drawWifiQr(fb, ctx);
      const ssidLabel = `AP: ${ctx.apSsid.trim() || "Foxie-Setup"}`;
      drawTextCentered(fb, EPD_WIDTH / 2, 152, ssidLabel, 1);
      drawTextCentered(fb, EPD_WIDTH / 2, 168, "192.168.4.1", 1);
      break;
    }
  }

  fb.drawRect(0, 0, EPD_WIDTH, EPD_HEIGHT, true);
}
