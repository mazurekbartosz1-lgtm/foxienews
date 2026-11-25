#pragma once

#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>

struct CaptureUploadResult {
  bool ok = false;
  int httpStatus = 0;
  char shortError[24] = "";
  String remotePath;
  String noteTitle;
  String errorMessage;
};

using UploadProgressCb = void (*)(uint8_t percent);

/**
 * Streams a WAV buffer as Base64 JSON (`POST /api/capture`) with `X-API-Key`
 * without duplicating the encoded payload in DRAM.
 */
CaptureUploadResult uploadWavCapture(
  const String& apiUrl,
  const String& apiKey,
  const uint8_t* wavData,
  size_t wavSize,
  UploadProgressCb onProgress = nullptr
);
