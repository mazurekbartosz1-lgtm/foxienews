import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateUiAssetsHeader } from "../src/cpp-exporter.ts";
import { FOX_ASSET_REGISTRY } from "../src/fox-sprites.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const outputPath = path.resolve(
  __dirname,
  "../../firmware/include/ui_assets.h",
);

const headerContent = generateUiAssetsHeader();
fs.writeFileSync(outputPath, headerContent, "utf8");

const totalAssetBytes = FOX_ASSET_REGISTRY.reduce(
  (sum, item) => sum + item.bitmap.data.length,
  0,
);

console.log(
  `Exported ${FOX_ASSET_REGISTRY.length} sprites/icons (${totalAssetBytes} bytes PROGMEM) -> ${outputPath}`,
);
