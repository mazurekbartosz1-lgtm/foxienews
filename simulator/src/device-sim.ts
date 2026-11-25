import type { DeviceState, ScreenContext, WeatherKind } from "./screens.ts";

export type LedMode = "off" | "solid" | "fast-blink" | "slow-blink" | "pulse-ok";
export type ButtonName = "BOOT" | "PWR";

export interface SimulatorCallbacks {
  onRender: (ctx: ScreenContext, fullRefresh: boolean, reason: string) => void;
  onLog: (message: string) => void;
  onLedChange: (mode: LedMode) => void;
  onPowerHoldChange: (pwrHoldHigh: boolean) => void;
}

export const LONG_PRESS_THRESHOLD_MS = 2500;

function formatCurrentTime24h(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export class FoxieDeviceSim {
  private callbacks: SimulatorCallbacks;
  private simulateUploadError = false;
  private recTimer: number | null = null;
  private uploadTimer: number | null = null;
  private autoReturnTimer: number | null = null;
  private pwrHoldHigh = true;

  readonly ctx: ScreenContext = {
    state: "ready",
    wifiConnected: true,
    batteryPercent: 88,
    recordingSeconds: 0,
    audioLevel: 0.45,
    uploadStep: "Gemini transkrypcja",
    uploadProgress: 0,
    savedTitle: "Pomysł na czytnik e-ink",
    errorMessage: "Brak odpowiedzi API",
    apSsid: "Foxie-Setup",
    apPassword: "",
    sleeping: false,
    timeText: formatCurrentTime24h(),
    weatherTempC: 12,
    weatherKind: "partly",
  };

  constructor(callbacks: SimulatorCallbacks) {
    this.callbacks = callbacks;
  }

  setSimulateUploadError(enabled: boolean): void {
    this.simulateUploadError = enabled;
  }

  setBatteryPercent(percent: number): void {
    this.ctx.batteryPercent = Math.max(0, Math.min(100, percent));
    this.emitRender(false, "Aktualizacja poziomu baterii");
  }

  setWifiConfig(ssid: string, password: string): void {
    this.ctx.apSsid = ssid;
    this.ctx.apPassword = password;
    if (this.ctx.state === "wifi") {
      this.emitRender(false, "Aktualizacja kodu QR Wi-Fi");
    }
  }

  setWeather(kind: WeatherKind, tempC: number | null): void {
    this.ctx.weatherKind = kind;
    this.ctx.weatherTempC = tempC;
    if (!this.ctx.sleeping && this.ctx.state === "ready") {
      this.emitRender(false, `Aktualizacja pogody (${kind})`);
    }
  }

  refreshClock(): void {
    const nextTime = formatCurrentTime24h();
    if (nextTime !== this.ctx.timeText) {
      this.ctx.timeText = nextTime;
      if (this.ctx.state === "ready" || this.ctx.state === "hibernate" || this.ctx.sleeping) {
        this.emitRender(false, "Odświeżenie zegara 24h");
      }
    }
  }

  enterDeepSleep(reason = "Hibernacja (2h bezczynności)"): void {
    this.clearTimers();
    this.ctx.sleeping = true;
    this.ctx.state = "hibernate";
    this.pwrHoldHigh = true;
    this.callbacks.onPowerHoldChange(true);
    this.syncLed();
    this.emitRender(true, `${reason} -> Deep sleep (Wi-Fi OFF, zegar widoczny)`);
  }

  touchScreen(): void {
    if (this.ctx.sleeping || this.ctx.state === "hibernate") {
      this.ctx.sleeping = false;
      this.ctx.state = "ready";
      this.ctx.timeText = formatCurrentTime24h();
      this.syncLed();
      this.emitRender(true, "Dotyk ekranu (TP_INT) -> Wybudzono z hibernacji");
    }
  }

  setStateDirect(next: DeviceState): void {
    this.clearTimers();
    this.ctx.sleeping = next === "hibernate";
    this.ctx.timeText = formatCurrentTime24h();
    this.pwrHoldHigh = true;
    this.callbacks.onPowerHoldChange(true);
    this.ctx.state = next;

    if (next === "recording") {
      this.ctx.recordingSeconds = 4;
      this.ctx.audioLevel = 0.65;
      this.startRecordingTicker();
    } else if (next === "uploading") {
      this.ctx.uploadStep = "Transkrypcja Gemini API";
      this.ctx.uploadProgress = 55;
    }

    this.syncLed();
    this.emitRender(true, `Ręczne przełączenie -> ${next}`);
  }

  forceFullRefresh(): void {
    this.emitRender(true, "Ręczne pełne odświeżenie e-paper");
  }

  handleButtonPress(button: ButtonName, durationMs: number): void {
    const isLong = durationMs >= LONG_PRESS_THRESHOLD_MS;
    const kind = isLong ? "długie przytrzymanie" : "krótkie kliknięcie";
    this.callbacks.onLog(`${button}: ${kind} (${durationMs} ms)`);

    if (button === "PWR") {
      this.handlePwrButton(isLong);
    } else {
      this.handleBootButton(isLong);
    }
  }

  private handleBootButton(isLong: boolean): void {
    if (this.ctx.sleeping) {
      this.ctx.sleeping = false;
      this.ctx.state = isLong ? "wifi" : "ready";
      this.ctx.timeText = formatCurrentTime24h();
      this.syncLed();
      this.emitRender(true, "BOOT -> Wybudzono z hibernacji");
      return;
    }

    if (isLong) {
      this.clearTimers();
      this.ctx.sleeping = false;
      this.pwrHoldHigh = true;
      this.callbacks.onPowerHoldChange(true);
      this.ctx.state = "wifi";
      this.syncLed();
      this.emitRender(true, "BOOT (3s) -> Tryb konfiguracji Wi-Fi QR");
      return;
    }

    switch (this.ctx.state) {
      case "ready":
      case "saved":
        this.startRecording();
        break;
      case "recording":
        this.stopRecordingAndUpload();
        break;
      case "error":
        this.startUploadSequence();
        break;
      case "wifi":
      case "uploading":
        break;
    }
  }

  private handlePwrButton(isLong: boolean): void {
    if (isLong) {
      if (this.ctx.sleeping) {
        this.touchScreen();
      } else {
        this.enterDeepSleep("PWR (3s)");
      }
      return;
    }

    if (this.ctx.sleeping) {
      this.ctx.sleeping = false;
      this.ctx.state = "ready";
      this.ctx.timeText = formatCurrentTime24h();
      this.syncLed();
      this.emitRender(true, "PWR -> Wybudzono z hibernacji");
      return;
    }

    if (this.ctx.state === "recording") {
      this.clearTimers();
      this.ctx.state = "ready";
      this.syncLed();
      this.emitRender(true, "PWR -> Anulowano nagrywanie");
      return;
    }

    if (this.ctx.state !== "ready") {
      this.clearTimers();
      this.ctx.state = "ready";
      this.syncLed();
      this.emitRender(true, "PWR -> Powrót do ekranu głównego");
      return;
    }

    this.emitRender(true, "PWR -> Pełne odświeżenie ekranu");
  }

  private startRecording(): void {
    this.clearTimers();
    this.ctx.state = "recording";
    this.ctx.recordingSeconds = 0;
    this.ctx.audioLevel = 0.5;
    this.syncLed();
    this.emitRender(true, "BOOT -> Start nagrywania (ES8311 -> PSRAM)");
    this.startRecordingTicker();
  }

  private startRecordingTicker(): void {
    this.recTimer = window.setInterval(() => {
      this.ctx.recordingSeconds += 1;
      this.ctx.audioLevel = 0.25 + ((this.ctx.recordingSeconds * 37) % 75) / 100;
      this.emitRender(false, "Odświeżenie częściowe licznika nagrywania");
    }, 1000);
  }

  private stopRecordingAndUpload(): void {
    this.clearTimers();
    this.callbacks.onLog(
      `Zakończono nagranie (${this.ctx.recordingSeconds}s WAV 16kHz mono)`,
    );
    this.startUploadSequence();
  }

  private startUploadSequence(): void {
    this.clearTimers();
    this.ctx.state = "uploading";
    this.ctx.uploadStep = "Wysyłanie WAV (POST /api/capture)";
    this.ctx.uploadProgress = 25;
    this.syncLed();
    this.emitRender(true, "Start wysyłania nagrania");

    let step = 0;
    this.uploadTimer = window.setInterval(() => {
      step += 1;
      if (step === 1) {
        this.ctx.uploadStep = "Transkrypcja Gemini API";
        this.ctx.uploadProgress = 65;
        this.emitRender(false, "Postęp wysyłki 65%");
      } else if (step === 2) {
        this.ctx.uploadStep = "Commit .md -> GitHub raw/inbox/";
        this.ctx.uploadProgress = 90;
        this.emitRender(false, "Postęp wysyłki 90%");
      } else {
        this.clearTimers();
        if (this.simulateUploadError || !this.ctx.wifiConnected) {
          this.ctx.state = "error";
          this.ctx.errorMessage = "Błąd połączenia z API";
          this.syncLed();
          this.emitRender(true, "Symulowany błąd wysyłki");
        } else {
          this.ctx.state = "saved";
          this.ctx.savedTitle = `Notatka głosowa (${this.ctx.recordingSeconds}s)`;
          this.syncLed();
          this.emitRender(true, "Zapisano notatkę w raw/inbox/");

          this.autoReturnTimer = window.setTimeout(() => {
            if (this.ctx.state === "saved") {
              this.ctx.state = "ready";
              this.syncLed();
              this.emitRender(true, "Auto-powrót do ekranu głównego");
            }
          }, 3500);
        }
      }
    }, 750);
  }

  private syncLed(): void {
    if (this.ctx.sleeping) {
      this.callbacks.onLedChange("off");
      return;
    }
    switch (this.ctx.state) {
      case "ready":
        this.callbacks.onLedChange("off");
        break;
      case "recording":
        this.callbacks.onLedChange("slow-blink");
        break;
      case "uploading":
        this.callbacks.onLedChange("fast-blink");
        break;
      case "saved":
        this.callbacks.onLedChange("pulse-ok");
        break;
      case "error":
      case "wifi":
        this.callbacks.onLedChange("slow-blink");
        break;
      case "hibernate":
        this.callbacks.onLedChange("off");
        break;
    }
  }

  private emitRender(fullRefresh: boolean, reason: string): void {
    this.callbacks.onRender({ ...this.ctx }, fullRefresh, reason);
  }

  private clearTimers(): void {
    if (this.recTimer !== null) {
      window.clearInterval(this.recTimer);
      this.recTimer = null;
    }
    if (this.uploadTimer !== null) {
      window.clearInterval(this.uploadTimer);
      this.uploadTimer = null;
    }
    if (this.autoReturnTimer !== null) {
      window.clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = null;
    }
  }

  isPowerHoldHigh(): boolean {
    return this.pwrHoldHigh;
  }
}
