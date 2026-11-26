#include "sd_queue.h"

#include <FS.h>
#include <SD_MMC.h>
#include <stdlib.h>
#include <time.h>
#include "board_pins.h"

namespace {

constexpr const char* QUEUE_DIR = "/foxie_queue";
constexpr size_t SD_WRITE_CHUNK_BYTES = 4096;
constexpr size_t MAX_WAV_FILE_BYTES = 10UL * 1024UL * 1024UL;

String normalizeEntryPath(const char* rawName) {
  String name = rawName ? String(rawName) : String();
  if (!name.startsWith("/")) {
    name = String(QUEUE_DIR) + "/" + name;
  }
  return name;
}

bool isWavFileName(const String& path) {
  return path.endsWith(".wav") || path.endsWith(".WAV");
}

} // namespace

bool SdQueue::ensureMounted() {
  if (mounted_) {
    return true;
  }
  if (!cardAvailable_) {
    return false;
  }

  pinMode(PIN_SD_CMD, INPUT_PULLUP);
  pinMode(PIN_SD_D0, INPUT_PULLUP);

  if (!SD_MMC.setPins(PIN_SD_CLK, PIN_SD_CMD, PIN_SD_D0)) {
    return false;
  }

  if (!SD_MMC.begin("/sdcard", true, false, SDMMC_FREQ_DEFAULT)) {
    return false;
  }

  if (SD_MMC.cardType() == CARD_NONE) {
    SD_MMC.end();
    return false;
  }

  mounted_ = true;
  return true;
}

void SdQueue::suspend() {
  if (!mounted_) return;
  SD_MMC.end();
  mounted_ = false;
}

bool SdQueue::begin() {
  cardAvailable_ = false;
  mounted_ = false;
  pendingCount_ = 0;

  pinMode(PIN_SD_CMD, INPUT_PULLUP);
  pinMode(PIN_SD_D0, INPUT_PULLUP);

  if (!SD_MMC.setPins(PIN_SD_CLK, PIN_SD_CMD, PIN_SD_D0)) {
    Serial.println("[SD] ERROR: SD_MMC.setPins failed");
    return false;
  }

  if (!SD_MMC.begin("/sdcard", true, false, SDMMC_FREQ_DEFAULT)) {
    Serial.println("[SD] No MicroSD card detected (offline queue disabled)");
    return false;
  }

  uint8_t cardType = SD_MMC.cardType();
  if (cardType == CARD_NONE) {
    Serial.println("[SD] CARD_NONE (offline queue disabled)");
    SD_MMC.end();
    return false;
  }

  if (!SD_MMC.exists(QUEUE_DIR)) {
    if (!SD_MMC.mkdir(QUEUE_DIR)) {
      Serial.println("[SD] ERROR: Failed to create /foxie_queue");
      SD_MMC.end();
      return false;
    }
  }

  cardAvailable_ = true;
  mounted_ = true;
  refreshCount();

  uint64_t cardSizeMb = SD_MMC.cardSize() / (1024ULL * 1024ULL);
  Serial.printf("[SD] Mounted 1-bit SDMMC (%llu MB), pending WAVs: %u\n",
                static_cast<unsigned long long>(cardSizeMb),
                pendingCount_);

  if (pendingCount_ == 0) {
    suspend();
  }
  return true;
}

uint16_t SdQueue::refreshCount() {
  if (!ensureMounted()) {
    pendingCount_ = 0;
    return 0;
  }

  File dir = SD_MMC.open(QUEUE_DIR);
  if (!dir || !dir.isDirectory()) {
    if (dir) dir.close();
    pendingCount_ = 0;
    return 0;
  }

  uint16_t count = 0;
  File entry = dir.openNextFile();
  while (entry) {
    if (!entry.isDirectory()) {
      String path = normalizeEntryPath(entry.name());
      if (isWavFileName(path)) {
        count++;
      }
    }
    entry.close();
    entry = dir.openNextFile();
  }
  dir.close();

  pendingCount_ = count;
  return count;
}

bool SdQueue::enqueueWav(const uint8_t* wavData, size_t wavSize, String& outPath) {
  outPath = "";
  if (wavData == nullptr || wavSize <= 44 || !ensureMounted()) {
    return false;
  }

  struct tm tmNow {};
  char baseName[48];
  if (getLocalTime(&tmNow, 5) && tmNow.tm_year + 1900 >= 2024) {
    snprintf(
      baseName,
      sizeof(baseName),
      "%04d%02d%02d-%02d%02d%02d-%04lu",
      tmNow.tm_year + 1900,
      tmNow.tm_mon + 1,
      tmNow.tm_mday,
      tmNow.tm_hour,
      tmNow.tm_min,
      tmNow.tm_sec,
      static_cast<unsigned long>(millis() % 10000UL)
    );
  } else {
    snprintf(
      baseName,
      sizeof(baseName),
      "00000000-%010lu",
      static_cast<unsigned long>(millis())
    );
  }

  String tmpPath = String(QUEUE_DIR) + "/" + baseName + ".tmp";
  String finalPath = String(QUEUE_DIR) + "/" + baseName + ".wav";

  File file = SD_MMC.open(tmpPath, FILE_WRITE);
  if (!file) {
    Serial.printf("[SD] ERROR: Cannot open %s for write\n", tmpPath.c_str());
    return false;
  }

  size_t totalWritten = 0;
  while (totalWritten < wavSize) {
    size_t chunk = wavSize - totalWritten;
    if (chunk > SD_WRITE_CHUNK_BYTES) {
      chunk = SD_WRITE_CHUNK_BYTES;
    }
    size_t n = file.write(wavData + totalWritten, chunk);
    if (n == 0) {
      break;
    }
    totalWritten += n;
  }
  file.flush();
  file.close();

  if (totalWritten != wavSize) {
    Serial.printf("[SD] ERROR: Short write (%u/%u B)\n",
                  static_cast<unsigned>(totalWritten),
                  static_cast<unsigned>(wavSize));
    SD_MMC.remove(tmpPath);
    return false;
  }

  if (!SD_MMC.rename(tmpPath, finalPath)) {
    Serial.printf("[SD] ERROR: Rename %s -> %s failed\n", tmpPath.c_str(), finalPath.c_str());
    SD_MMC.remove(tmpPath);
    suspend();
    return false;
  }

  outPath = finalPath;
  refreshCount();
  Serial.printf("[SD] Queued offline WAV: %s (%u B, pending=%u)\n",
                finalPath.c_str(),
                static_cast<unsigned>(wavSize),
                pendingCount_);
  suspend();
  return true;
}

bool SdQueue::peekOldest(String& outPath) {
  outPath = "";
  if (!ensureMounted()) return false;

  File dir = SD_MMC.open(QUEUE_DIR);
  if (!dir || !dir.isDirectory()) {
    if (dir) dir.close();
    return false;
  }

  String oldest;
  File entry = dir.openNextFile();
  while (entry) {
    if (!entry.isDirectory()) {
      String path = normalizeEntryPath(entry.name());
      if (isWavFileName(path)) {
        if (oldest.isEmpty() || path < oldest) {
          oldest = path;
        }
      }
    }
    entry.close();
    entry = dir.openNextFile();
  }
  dir.close();

  if (oldest.isEmpty()) {
    pendingCount_ = 0;
    return false;
  }

  outPath = oldest;
  return true;
}

bool SdQueue::readFileToPsram(const String& path, uint8_t*& outBuf, size_t& outSize) {
  outBuf = nullptr;
  outSize = 0;
  if (path.isEmpty() || !ensureMounted()) return false;

  File file = SD_MMC.open(path, FILE_READ);
  if (!file || file.isDirectory()) {
    if (file) file.close();
    return false;
  }

  size_t fileSize = static_cast<size_t>(file.size());
  if (fileSize <= 44 || fileSize > MAX_WAV_FILE_BYTES) {
    Serial.printf("[SD] ERROR: Invalid WAV file size %u for %s\n",
                  static_cast<unsigned>(fileSize),
                  path.c_str());
    file.close();
    return false;
  }

  uint8_t* buf = static_cast<uint8_t*>(ps_malloc(fileSize));
  if (buf == nullptr) {
    Serial.printf("[SD] ERROR: ps_malloc(%u) failed\n", static_cast<unsigned>(fileSize));
    file.close();
    return false;
  }

  size_t totalRead = 0;
  while (totalRead < fileSize) {
    size_t n = file.read(buf + totalRead, fileSize - totalRead);
    if (n == 0) {
      break;
    }
    totalRead += n;
  }
  file.close();

  if (totalRead != fileSize) {
    Serial.printf("[SD] ERROR: Short read (%u/%u B) from %s\n",
                  static_cast<unsigned>(totalRead),
                  static_cast<unsigned>(fileSize),
                  path.c_str());
    free(buf);
    return false;
  }

  outBuf = buf;
  outSize = fileSize;
  return true;
}

bool SdQueue::removeFile(const String& path) {
  if (path.isEmpty() || !ensureMounted()) return false;
  bool removed = SD_MMC.remove(path);
  refreshCount();
  Serial.printf("[SD] Removed %s (ok=%d, pending=%u)\n",
                path.c_str(),
                removed ? 1 : 0,
                pendingCount_);
  return removed;
}

void SdQueue::prepareForDeepSleep() {
  suspend();
}
