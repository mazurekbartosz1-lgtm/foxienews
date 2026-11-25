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
  ICON_ALERT,
  ICON_CHECK,
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
  audioLevel: number; // 0..1
  uploadStep: string;
  uploadProgress: number; // 0..100
  savedTitle: string;
  errorMessage: string;
  apSsid: string;
  apPassword: string;
  sleeping: boolean;
}

const STATE_LABELS: Record<DeviceState, string> = {
  ready: "GOTOWY",
  recording: "NAGRYWANIE",
  uploading: "WYSYŁANIE",
  saved: "ZAPISANO",
  error: "BŁĄD",
  wifi: "WI-FI AP",
};

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

function drawStatusBar(fb: EinkFramebuffer, ctx: ScreenContext): void {
  const wifiIcon = ctx.wifiConnected ? ICON_WIFI_ON : ICON_WIFI_OFF;
  fb.drawBitmap(6, 3, wifiIcon);

  const label = ctx.sleeping ? "UŚPIONY" : STATE_LABELS[ctx.state];
  drawText(fb, 26, 7, label, 1, true);

  const batText = `${Math.round(ctx.batteryPercent)}%`;
  drawText(fb, 144, 7, batText, 1, true);
  drawBatteryIcon(fb, 172, 6, ctx.batteryPercent);

  fb.drawHLine(0, UI_LAYOUT.STATUS_BAR_H, EPD_WIDTH, true);
}

function drawFooter(
  fb: EinkFramebuffer,
  leftHint: string,
  rightHint: string,
): void {
  fb.drawHLine(0, UI_LAYOUT.FOOTER_Y, EPD_WIDTH, true);
  drawText(fb, 8, UI_LAYOUT.FOOTER_Y + 9, leftHint, 1, true);
  if (rightHint) {
    drawText(fb, 110, UI_LAYOUT.FOOTER_Y + 9, rightHint, 1, true);
  }
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

  // Quiet zone frame
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
      fb.drawBitmap(UI_LAYOUT.FOX_X, UI_LAYOUT.FOX_Y, FOX_SPRITE_SLEEP);
      if (ctx.sleeping) {
        drawTextCentered(fb, EPD_WIDTH / 2, UI_LAYOUT.TITLE_Y, "FOXIE ŚPI", 2);
        drawTextCentered(
          fb,
          EPD_WIDTH / 2,
          UI_LAYOUT.SUBTITLE_Y + 4,
          "Naciśnij PWR aby wybudzić",
          1,
        );
        drawFooter(fb, "PWR:Wybudź", "PWR(3s):Uśpij");
      } else {
        drawTextCentered(fb, EPD_WIDTH / 2, UI_LAYOUT.TITLE_Y, "GOTOWY", 2);
        drawTextCentered(
          fb,
          EPD_WIDTH / 2,
          UI_LAYOUT.SUBTITLE_Y + 4,
          ctx.wifiConnected ? "Połączono z Wi-Fi" : "Brak sieci Wi-Fi",
          1,
        );
        drawFooter(fb, "BOOT:Nagraj", "BOOT(3s):Wi-Fi");
      }
      break;
    }

    case "recording": {
      fb.drawBitmap(UI_LAYOUT.FOX_X, UI_LAYOUT.FOX_Y, FOX_SPRITE_LISTEN);
      fb.drawBitmap(14, 56, ICON_MIC);
      drawTextCentered(
        fb,
        EPD_WIDTH / 2,
        UI_LAYOUT.TITLE_Y,
        formatDuration(ctx.recordingSeconds),
        2,
      );
      drawTextCentered(
        fb,
        EPD_WIDTH / 2,
        UI_LAYOUT.SUBTITLE_Y,
        "Słucham notatki...",
        1,
      );

      // Simple 1-bit audio level bars (WAV 16kHz PSRAM indicator)
      const bars = 12;
      const barStartX = 34;
      for (let i = 0; i < bars; i++) {
        const threshold = (i + 1) / bars;
        const barH = 4 + (i % 3) * 3;
        const active = ctx.audioLevel >= threshold * 0.85;
        if (active) {
          fb.fillRect(barStartX + i * 11, UI_LAYOUT.PROGRESS_Y + (10 - barH), 7, barH, true);
        } else {
          fb.drawRect(barStartX + i * 11, UI_LAYOUT.PROGRESS_Y + (10 - barH), 7, barH, true);
        }
      }

      drawFooter(fb, "BOOT:Wyślij", "PWR:Anuluj");
      break;
    }

    case "uploading": {
      fb.drawBitmap(UI_LAYOUT.FOX_X, UI_LAYOUT.FOX_Y, FOX_SPRITE_UPLOAD);
      drawTextCentered(fb, EPD_WIDTH / 2, UI_LAYOUT.TITLE_Y, "WYSYŁAM...", 2);
      drawTextCentered(
        fb,
        EPD_WIDTH / 2,
        UI_LAYOUT.SUBTITLE_Y,
        ctx.uploadStep || "Gemini + GitHub",
        1,
      );
      drawProgressBar(fb, 28, UI_LAYOUT.PROGRESS_Y, 144, 12, ctx.uploadProgress);
      drawFooter(fb, "Proszę czekać", "");
      break;
    }

    case "saved": {
      fb.drawBitmap(UI_LAYOUT.FOX_X, UI_LAYOUT.FOX_Y, FOX_SPRITE_SAVED);
      fb.drawBitmap(14, 56, ICON_CHECK);
      drawTextCentered(fb, EPD_WIDTH / 2, UI_LAYOUT.TITLE_Y, "ZAPISANO!", 2);
      const clippedTitle =
        ctx.savedTitle.length > 28
          ? `${ctx.savedTitle.slice(0, 25)}...`
          : ctx.savedTitle;
      drawTextCentered(fb, EPD_WIDTH / 2, UI_LAYOUT.SUBTITLE_Y, clippedTitle, 1);
      drawTextCentered(
        fb,
        EPD_WIDTH / 2,
        UI_LAYOUT.PROGRESS_Y,
        "raw/inbox/ -> GitHub OK",
        1,
      );
      drawFooter(fb, "BOOT:Nowa", "PWR:Gotowy");
      break;
    }

    case "error": {
      fb.drawBitmap(UI_LAYOUT.FOX_X, UI_LAYOUT.FOX_Y, FOX_SPRITE_ERROR);
      fb.drawBitmap(14, 56, ICON_ALERT);
      drawTextCentered(fb, EPD_WIDTH / 2, UI_LAYOUT.TITLE_Y, "BŁĄD", 2);
      const clippedErr =
        ctx.errorMessage.length > 28
          ? `${ctx.errorMessage.slice(0, 25)}...`
          : ctx.errorMessage;
      drawTextCentered(fb, EPD_WIDTH / 2, UI_LAYOUT.SUBTITLE_Y, clippedErr, 1);
      drawFooter(fb, "BOOT:Ponów", "PWR:Wróć");
      break;
    }

    case "wifi": {
      fb.drawBitmap(UI_LAYOUT.PEEK_X, UI_LAYOUT.PEEK_Y, FOX_SPRITE_PEEK);
      drawWifiQr(fb, ctx);
      const ssidLabel = `AP: ${ctx.apSsid.trim() || "Foxie-Setup"}`;
      drawTextCentered(fb, EPD_WIDTH / 2, 136, ssidLabel, 1);
      drawTextCentered(fb, EPD_WIDTH / 2, 150, "Zeskanuj QR -> 192.168.4.1", 1);
      drawFooter(fb, "Captive Portal", "PWR:Wróć");
      break;
    }
  }

  // Outer crisp 1px border around full 200x200 frame
  fb.drawRect(0, 0, EPD_WIDTH, EPD_HEIGHT, true);
}
