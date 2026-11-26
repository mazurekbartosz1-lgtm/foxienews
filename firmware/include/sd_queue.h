#pragma once

#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>

/**
 * Offline WAV recording queue stored on onboard MicroSD (1-bit SDMMC) under /foxie_queue.
 * Gracefully degrades when no card is inserted.
 */
class SdQueue {
public:
  bool begin();
  bool isMounted() const { return mounted_; }
  uint16_t pendingCount() const { return pendingCount_; }

  bool enqueueWav(const uint8_t* wavData, size_t wavSize, String& outPath);
  bool peekOldest(String& outPath);
  bool readFileToPsram(const String& path, uint8_t*& outBuf, size_t& outSize);
  bool removeFile(const String& path);
  uint16_t refreshCount();
  void prepareForDeepSleep();

private:
  bool mounted_ = false;
  uint16_t pendingCount_ = 0;
};
