import {
  generateFullScreenCpp,
  generateUiAssetsHeader,
} from "./cpp-exporter.ts";
import {
  FoxieDeviceSim,
  LONG_PRESS_THRESHOLD_MS,
  type ButtonName,
  type LedMode,
} from "./device-sim.ts";
import { EPD_HEIGHT, EPD_WIDTH, EinkFramebuffer } from "./eink-canvas.ts";
import { renderDeviceScreen, type DeviceState, type ScreenContext } from "./screens.ts";

const canvasEl = document.getElementById("eink-canvas") as HTMLCanvasElement;
const ledEl = document.getElementById("led-gp3") as HTMLSpanElement;
const pwrHoldPill = document.getElementById("pwr-hold-pill") as HTMLSpanElement;
const hwLogEl = document.getElementById("hw-log") as HTMLPreElement;
const bootBtn = document.getElementById("btn-boot") as HTMLButtonElement;
const pwrBtn = document.getElementById("btn-pwr") as HTMLButtonElement;
const holdBar = document.getElementById("hold-bar") as HTMLDivElement;
const holdLabel = document.getElementById("hold-label") as HTMLSpanElement;
const holdMsEl = document.getElementById("hold-ms") as HTMLSpanElement;
const zoomButtons = document.querySelectorAll<HTMLButtonElement>("[data-zoom]");
const stateButtons = document.querySelectorAll<HTMLButtonElement>("[data-state]");
const exportTabs = document.querySelectorAll<HTMLButtonElement>("[data-export]");
const forceRefreshBtn = document.getElementById("btn-force-refresh") as HTMLButtonElement;
const clearLogBtn = document.getElementById("btn-clear-log") as HTMLButtonElement;
const chkEpaperFlash = document.getElementById("chk-epaper-flash") as HTMLInputElement;
const chkWifiConnected = document.getElementById("chk-wifi-connected") as HTMLInputElement;
const chkSimError = document.getElementById("chk-sim-error") as HTMLInputElement;
const rangeBattery = document.getElementById("range-battery") as HTMLInputElement;
const batteryValEl = document.getElementById("battery-val") as HTMLElement;
const inputApSsid = document.getElementById("input-ap-ssid") as HTMLInputElement;
const inputApPass = document.getElementById("input-ap-pass") as HTMLInputElement;
const cppPreview = document.getElementById("cpp-preview") as HTMLTextAreaElement;
const btnCopyCpp = document.getElementById("btn-copy-cpp") as HTMLButtonElement;
const btnDownloadCpp = document.getElementById("btn-download-cpp") as HTMLButtonElement;
const copyStatusEl = document.getElementById("copy-status") as HTMLSpanElement;

const fb = new EinkFramebuffer();
const cachedAssetsHeader = generateUiAssetsHeader();
let exportMode: "assets" | "screen" = "assets";
let refreshTimers: number[] = [];

function appendLog(message: string): void {
  const timestamp = new Date().toLocaleTimeString("pl-PL");
  hwLogEl.textContent = `[${timestamp}] ${message}\n${hwLogEl.textContent ?? ""}`.slice(0, 2200);
}

function clearRefreshTimers(): void {
  for (const id of refreshTimers) {
    window.clearTimeout(id);
  }
  refreshTimers = [];
}

function renderWithEpaperEffect(ctx: ScreenContext, fullRefresh: boolean): void {
  renderDeviceScreen(fb, ctx);
  clearRefreshTimers();

  if (fullRefresh && chkEpaperFlash.checked) {
    fb.renderToCanvas(canvasEl, { allBlack: true });
    refreshTimers.push(
      window.setTimeout(() => {
        fb.renderToCanvas(canvasEl, { inverted: true });
      }, 90),
    );
    refreshTimers.push(
      window.setTimeout(() => {
        fb.renderToCanvas(canvasEl);
      }, 190),
    );
  } else {
    fb.renderToCanvas(canvasEl);
  }

  refreshCppPreview(ctx.state);
}

function refreshCppPreview(stateName: string): void {
  if (exportMode === "assets") {
    cppPreview.value = cachedAssetsHeader;
  } else {
    cppPreview.value = generateFullScreenCpp(fb, stateName);
  }
}

function updateActiveStateButton(state: DeviceState): void {
  stateButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.state === state);
  });
}

function setLedMode(mode: LedMode): void {
  ledEl.className = `led ${mode}`;
}

function setPowerHold(high: boolean): void {
  pwrHoldPill.classList.toggle("on", high);
  pwrHoldPill.textContent = high ? "PWR_HOLD: HIGH" : "PWR_HOLD: LOW";
}

const sim = new FoxieDeviceSim({
  onRender(ctx, fullRefresh, reason) {
    updateActiveStateButton(ctx.state);
    renderWithEpaperEffect(ctx, fullRefresh);
    if (fullRefresh) {
      appendLog(`[E-INK FULL] ${reason}`);
    }
  },
  onLog(msg) {
    appendLog(msg);
  },
  onLedChange(mode) {
    setLedMode(mode);
  },
  onPowerHoldChange(high) {
    setPowerHold(high);
  },
});

function setZoom(scale: number): void {
  canvasEl.style.width = `${EPD_WIDTH * scale}px`;
  canvasEl.style.height = `${EPD_HEIGHT * scale}px`;
  zoomButtons.forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.zoom) === scale);
  });
}

function wireHardwareButton(
  el: HTMLButtonElement,
  name: ButtonName,
  shortcutKey: string,
): void {
  let downAt = 0;
  let meterInterval: number | null = null;

  const stopMeter = () => {
    if (meterInterval !== null) {
      window.clearInterval(meterInterval);
      meterInterval = null;
    }
    holdBar.style.width = "0%";
    holdBar.classList.remove("threshold");
    holdLabel.textContent = "Przytrzymaj ≥ 2.5 s dla funkcji długiego kliku";
    holdMsEl.textContent = "0 ms";
    el.classList.remove("pressed");
  };

  const press = () => {
    if (downAt) return;
    downAt = performance.now();
    el.classList.add("pressed");
    holdLabel.textContent = `Trzymasz ${name}...`;
    meterInterval = window.setInterval(() => {
      const elapsed = Math.round(performance.now() - downAt);
      const pct = Math.min(100, (elapsed / LONG_PRESS_THRESHOLD_MS) * 100);
      holdBar.style.width = `${pct}%`;
      holdBar.classList.toggle("threshold", elapsed >= LONG_PRESS_THRESHOLD_MS);
      holdMsEl.textContent = `${elapsed} ms`;
    }, 30);
  };

  const release = () => {
    if (!downAt) return;
    const duration = Math.round(performance.now() - downAt);
    downAt = 0;
    stopMeter();
    sim.handleButtonPress(name, duration);
  };

  el.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    press();
  });
  el.addEventListener("pointerup", release);
  el.addEventListener("pointerleave", release);
  el.addEventListener("pointercancel", release);

  window.addEventListener("keydown", (ev) => {
    if (
      ev.repeat ||
      ev.target instanceof HTMLInputElement ||
      ev.target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (ev.key.toLowerCase() === shortcutKey) {
      press();
    }
  });
  window.addEventListener("keyup", (ev) => {
    if (ev.key.toLowerCase() === shortcutKey) {
      release();
    }
  });
}

zoomButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    setZoom(Number(btn.dataset.zoom) || 2);
  });
});

stateButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const state = btn.dataset.state as DeviceState;
    sim.setStateDirect(state);
  });
});

exportTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    exportMode = tab.dataset.export === "screen" ? "screen" : "assets";
    exportTabs.forEach((t) => t.classList.toggle("active", t === tab));
    refreshCppPreview(sim.ctx.state);
  });
});

forceRefreshBtn.addEventListener("click", () => sim.forceFullRefresh());
clearLogBtn.addEventListener("click", () => {
  hwLogEl.textContent = "";
});

chkWifiConnected.addEventListener("change", () => {
  sim.ctx.wifiConnected = chkWifiConnected.checked;
  renderWithEpaperEffect(sim.ctx, false);
});

chkSimError.addEventListener("change", () => {
  sim.setSimulateUploadError(chkSimError.checked);
});

rangeBattery.addEventListener("input", () => {
  const pct = Number(rangeBattery.value);
  batteryValEl.textContent = `${pct}%`;
  sim.setBatteryPercent(pct);
});

const syncWifiInputs = () => {
  sim.setWifiConfig(inputApSsid.value, inputApPass.value);
};
inputApSsid.addEventListener("input", syncWifiInputs);
inputApPass.addEventListener("input", syncWifiInputs);

btnCopyCpp.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(cppPreview.value);
    copyStatusEl.textContent = "Skopiowano do schowka.";
  } catch {
    cppPreview.select();
    copyStatusEl.textContent = "Zaznaczono tekst (Ctrl+C).";
  }
  window.setTimeout(() => {
    copyStatusEl.textContent = "";
  }, 2500);
});

btnDownloadCpp.addEventListener("click", () => {
  const blob = new Blob([cachedAssetsHeader], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ui_assets.h";
  a.click();
  URL.revokeObjectURL(url);
});

window.addEventListener("keydown", (ev) => {
  if (
    ev.target instanceof HTMLInputElement ||
    ev.target instanceof HTMLTextAreaElement
  ) {
    return;
  }
  const stateMap: Record<string, DeviceState> = {
    "1": "ready",
    "2": "recording",
    "3": "uploading",
    "4": "saved",
    "5": "error",
    "6": "wifi",
  };
  const next = stateMap[ev.key];
  if (next) {
    sim.setStateDirect(next);
  }
});

wireHardwareButton(bootBtn, "BOOT", "b");
wireHardwareButton(pwrBtn, "PWR", "p");

setZoom(2);
sim.setStateDirect("ready");
