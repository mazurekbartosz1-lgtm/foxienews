#pragma once

#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>
#include "driver/i2s_std.h"

namespace foxie_audio {

constexpr uint32_t SAMPLE_RATE = 16000;
constexpr uint8_t BITS_PER_SAMPLE = 16;
constexpr uint8_t CHANNELS = 1;
constexpr uint32_t MAX_DURATION_SEC = 60;
constexpr size_t WAV_HEADER_SIZE = 44;
constexpr size_t MAX_PCM_BYTES =
  static_cast<size_t>(SAMPLE_RATE) * (BITS_PER_SAMPLE / 8) * CHANNELS * MAX_DURATION_SEC;
constexpr size_t WAV_BUFFER_BYTES = WAV_HEADER_SIZE + MAX_PCM_BYTES;

struct CaptureStats {
  uint32_t wavBytes = 0;
  uint32_t pcmBytes = 0;
  uint32_t durationMs = 0;
  int16_t peakAbs = 0;
  uint16_t rms = 0;
  bool reachedLimit = false;
};

} // namespace foxie_audio

/**
 * Controls the onboard ES8311 audio codec (I2C + I2S Master RX) and captures
 * 16 kHz / 16-bit / mono WAV audio directly into 8 MB OPI PSRAM.
 */
class AudioRecorder {
public:
  bool begin();
  bool isReady() const { return ready_; }
  bool isRecording() const { return recordingActive_; }
  bool hasReachedLimit() const { return reachedLimit_; }

  bool startRecording();
  bool stopRecording(foxie_audio::CaptureStats& outStats);
  void prepareForDeepSleep();

  const uint8_t* wavData() const { return wavBuffer_; }
  size_t wavSize() const {
    return wavBuffer_ ? (foxie_audio::WAV_HEADER_SIZE + pcmBytesWritten_) : 0;
  }
  uint32_t currentPcmBytes() const { return pcmBytesWritten_; }
  uint16_t chipId() const { return (static_cast<uint16_t>(chipIdHigh_) << 8) | chipIdLow_; }
  uint8_t chipRev() const { return chipRev_; }
  size_t probeBytes() const { return probeBytes_; }
  int16_t probePeak() const { return probePeak_; }
  uint16_t probeRms() const { return probeRms_; }

private:
  static void captureTaskTrampoline(void* arg);
  void captureTaskLoop();

  bool writeReg(uint8_t reg, uint8_t val);
  bool readReg(uint8_t reg, uint8_t& val);
  bool configureEs8311Registers();
  bool initI2sRx();
  void writeWavHeader(uint32_t pcmBytes);

  bool ready_ = false;
  volatile bool recordingActive_ = false;
  volatile bool taskRunning_ = false;
  volatile bool reachedLimit_ = false;
  volatile uint32_t pcmBytesWritten_ = 0;

  uint8_t* wavBuffer_ = nullptr;
  i2s_chan_handle_t rxHandle_ = nullptr;
  TaskHandle_t captureTaskHandle_ = nullptr;
  uint8_t chipIdHigh_ = 0;
  uint8_t chipIdLow_ = 0;
  uint8_t chipRev_ = 0;
  size_t probeBytes_ = 0;
  int16_t probePeak_ = 0;
  uint16_t probeRms_ = 0;
};
