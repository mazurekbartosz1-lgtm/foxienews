import { EPD_HEIGHT, EPD_WIDTH, EinkFramebuffer } from "./eink-canvas";

const canvasEl = document.getElementById("eink-canvas") as HTMLCanvasElement;
const ledEl = document.getElementById("led-gp3") as HTMLSpanElement;
const hwLogEl = document.getElementById("hw-log") as HTMLPreElement;
const toggleLedBtn = document.getElementById("btn-toggle-led") as HTMLButtonElement;
const bootBtn = document.getElementById("btn-boot") as HTMLButtonElement;
const pwrBtn = document.getElementById("btn-pwr") as HTMLButtonElement;
const zoomButtons = document.querySelectorAll<HTMLButtonElement>("[data-zoom]");

const fb = new EinkFramebuffer();

function drawScaffoldPattern(): void {
  fb.clear(false);
  fb.drawRect(2, 2, EPD_WIDTH - 4, EPD_HEIGHT - 4, true);
  fb.drawRect(6, 6, EPD_WIDTH - 12, EPD_HEIGHT - 12, true);

  // Minimal 1-bit crosshair & placeholder fox-ear silhouette test in center
  for (let x = 20; x < EPD_WIDTH - 20; x += 4) {
    fb.setPixel(x, 100, true);
  }
  for (let y = 20; y < EPD_HEIGHT - 20; y += 4) {
    fb.setPixel(100, y, true);
  }
  fb.drawRect(76, 76, 48, 48, true);
  fb.renderToCanvas(canvasEl);
}

function setZoom(scale: number): void {
  canvasEl.style.width = `${EPD_WIDTH * scale}px`;
  canvasEl.style.height = `${EPD_HEIGHT * scale}px`;
  zoomButtons.forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.zoom) === scale);
  });
}

function appendLog(message: string): void {
  const timestamp = new Date().toLocaleTimeString("pl-PL");
  hwLogEl.textContent = `[${timestamp}] ${message}\n${hwLogEl.textContent ?? ""}`.slice(0, 800);
}

function wireHoldButton(button: HTMLButtonElement, label: string): void {
  let pressedAt = 0;

  button.addEventListener("pointerdown", () => {
    pressedAt = performance.now();
  });

  const release = () => {
    if (!pressedAt) return;
    const durationMs = Math.round(performance.now() - pressedAt);
    pressedAt = 0;
    const kind = durationMs >= 2500 ? "długie przytrzymanie" : "krótkie kliknięcie";
    appendLog(`${label}: ${kind} (${durationMs} ms)`);
  };

  button.addEventListener("pointerup", release);
  button.addEventListener("pointerleave", release);
}

zoomButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    setZoom(Number(btn.dataset.zoom) || 2);
  });
});

toggleLedBtn.addEventListener("click", () => {
  const isOn = ledEl.classList.toggle("on");
  appendLog(`LED GP3: ${isOn ? "ON" : "OFF"}`);
});

wireHoldButton(bootBtn, "BOOT (GPIO0)");
wireHoldButton(pwrBtn, "PWR (GPIO18)");

setZoom(2);
drawScaffoldPattern();
