#include "audio_recorder.h"

#include <Wire.h>
#include <math.h>
#include <string.h>
#include "board_pins.h"

namespace {

constexpr size_t I2S_READ_CHUNK_BYTES = 2048;
constexpr size_t PROBE_READ_BYTES = 1024;

inline void writeLe16(uint8_t* dst, uint16_t v) {
  dst[0] = static_cast<uint8_t>(v & 0xFF);
  dst[1] = static_cast<uint8_t>((v >> 8) & 0xFF);
}

inline void writeLe32(uint8_t* dst, uint32_t v) {
  dst[0] = static_cast<uint8_t>(v & 0xFF);
  dst[1] = static_cast<uint8_t>((v >> 8) & 0xFF);
  dst[2] = static_cast<uint8_t>((v >> 16) & 0xFF);
  dst[3] = static_cast<uint8_t>((v >> 24) & 0xFF);
}

void computePcmStats(const uint8_t* pcm, size_t bytes, int16_t& outPeak, uint16_t& outRms) {
  size_t sampleCount = bytes / sizeof(int16_t);
  if (sampleCount == 0) {
    outPeak = 0;
    outRms = 0;
    return;
  }

  const auto* samples = reinterpret_cast<const int16_t*>(pcm);
  int32_t peak = 0;
  uint64_t sumSq = 0;

  for (size_t i = 0; i < sampleCount; i++) {
    int32_t s = samples[i];
    int32_t absVal = (s < 0) ? -s : s;
    if (absVal > peak) {
      peak = absVal;
    }
    sumSq += static_cast<uint64_t>(static_cast<int64_t>(s) * static_cast<int64_t>(s));
  }

  outPeak = static_cast<int16_t>(peak > 32767 ? 32767 : peak);
  outRms = static_cast<uint16_t>(sqrt(static_cast<double>(sumSq) / static_cast<double>(sampleCount)));
}

} // namespace

bool AudioRecorder::writeReg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(ES8311_I2C_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool AudioRecorder::readReg(uint8_t reg, uint8_t& val) {
  Wire.beginTransmission(ES8311_I2C_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) {
    return false;
  }
  if (Wire.requestFrom(ES8311_I2C_ADDR, static_cast<uint8_t>(1)) != 1) {
    return false;
  }
  val = static_cast<uint8_t>(Wire.read());
  return true;
}

bool AudioRecorder::initI2sRx() {
  i2s_chan_config_t chanCfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  chanCfg.auto_clear = true;
  chanCfg.dma_desc_num = 8;
  chanCfg.dma_frame_num = 512;

  esp_err_t err = i2s_new_channel(&chanCfg, nullptr, &rxHandle_);
  if (err != ESP_OK || rxHandle_ == nullptr) {
    Serial.printf("[Audio] i2s_new_channel failed: %d\n", static_cast<int>(err));
    return false;
  }

  i2s_std_config_t stdCfg = {};
  stdCfg.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(foxie_audio::SAMPLE_RATE);
  stdCfg.clk_cfg.mclk_multiple = I2S_MCLK_MULTIPLE_256;

  stdCfg.slot_cfg =
    I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
  stdCfg.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;

  stdCfg.gpio_cfg.mclk = static_cast<gpio_num_t>(PIN_I2S_MCLK);
  stdCfg.gpio_cfg.bclk = static_cast<gpio_num_t>(PIN_I2S_BCLK);
  stdCfg.gpio_cfg.ws = static_cast<gpio_num_t>(PIN_I2S_WS);
  stdCfg.gpio_cfg.dout = I2S_GPIO_UNUSED;
  stdCfg.gpio_cfg.din = static_cast<gpio_num_t>(PIN_I2S_DIN);
  stdCfg.gpio_cfg.invert_flags.mclk_inv = false;
  stdCfg.gpio_cfg.invert_flags.bclk_inv = false;
  stdCfg.gpio_cfg.invert_flags.ws_inv = false;

  err = i2s_channel_init_std_mode(rxHandle_, &stdCfg);
  if (err != ESP_OK) {
    Serial.printf("[Audio] i2s_channel_init_std_mode failed: %d\n", static_cast<int>(err));
    i2s_del_channel(rxHandle_);
    rxHandle_ = nullptr;
    return false;
  }

  return true;
}

bool AudioRecorder::configureEs8311Registers() {
  bool ok = true;

  // Clock & I2S setup for MCLK = 4.096 MHz, Fs = 16 kHz (256x), 16-bit Philips slave
  ok &= writeReg(0x45, 0x00);
  ok &= writeReg(0x01, 0x30);
  ok &= writeReg(0x02, 0x00); // pre_div=1, pre_multi=1
  ok &= writeReg(0x03, 0x10); // fs_mode=0 (Single Speed), adc_osr=0x10
  ok &= writeReg(0x04, 0x10); // dac_osr=0x10
  ok &= writeReg(0x05, 0x00); // adc_div=1, dac_div=1
  ok &= writeReg(0x06, 0x03); // bclk_div=4 (4 - 1 = 3)
  ok &= writeReg(0x07, 0x00); // lrck_h = 0x00
  ok &= writeReg(0x08, 0xFF); // lrck_l = 0xFF -> lrck_div = 256
  ok &= writeReg(0x09, 0x0C); // DAC SDP: 16-bit Philips I2S
  ok &= writeReg(0x0A, 0x0C); // ADC SDP: 16-bit Philips I2S

  // Soft reset and enable state machine + internal clocks
  ok &= writeReg(0x00, 0x1F);
  delay(20);
  ok &= writeReg(0x00, 0x80); // CSM_ON = 1, I2S slave mode
  ok &= writeReg(0x01, 0x3F); // Enable MCLK/BCLK/ADC/DAC clocks

  // Power up analog references, PGA, and ADC modulator
  ok &= writeReg(0x0D, 0x01);
  ok &= writeReg(0x0E, 0x02);
  ok &= writeReg(0x12, 0x00);
  ok &= writeReg(0x13, 0x10);

  // ADC high-pass DC offset filter + EQ bypass
  ok &= writeReg(0x1C, 0x6A);
  ok &= writeReg(0x37, 0x08);

  // Analog mic path (MIC1P-MIC1N, DMIC_ON=0, PGA +30 dB), ADC scale +24 dB, 0 dB vol
  ok &= writeReg(0x14, 0x1A);
  ok &= writeReg(0x16, 0x04);
  ok &= writeReg(0x17, 0xBF);
  ok &= writeReg(0x44, 0x08);

  return ok;
}

bool AudioRecorder::begin() {
  ready_ = false;

  // CRITICAL on Waveshare V2: enable ES8311 power rail (active-LOW) BEFORE Wire.begin()
  pinMode(PIN_AUDIO_PWR, OUTPUT);
  digitalWrite(PIN_AUDIO_PWR, AUDIO_PWR_ON_LEVEL);
  pinMode(PIN_AUDIO_PA_CTRL, OUTPUT);
  digitalWrite(PIN_AUDIO_PA_CTRL, LOW);
  delay(25);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 100000);

  uint8_t id1 = 0;
  uint8_t id2 = 0;
  uint8_t rev = 0;
  if (!readReg(0xFD, id1) || !readReg(0xFE, id2) || !readReg(0xFF, rev)) {
    Serial.println("[Audio] ERROR: ES8311 not responding on I2C (0x18)");
    return false;
  }
  chipIdHigh_ = id1;
  chipIdLow_ = id2;
  chipRev_ = rev;
  Serial.printf("[Audio] ES8311 detected: ID=0x%02X%02X rev=0x%02X\n", id1, id2, rev);
  if (id1 != 0x83 || id2 != 0x11) {
    Serial.println("[Audio] ERROR: Unexpected ES8311 chip ID");
    return false;
  }

  if (wavBuffer_ == nullptr) {
    wavBuffer_ = static_cast<uint8_t*>(ps_malloc(foxie_audio::WAV_BUFFER_BYTES));
    if (wavBuffer_ == nullptr) {
      Serial.println("[Audio] ERROR: Failed to allocate WAV buffer in PSRAM");
      return false;
    }
    Serial.printf("[Audio] PSRAM WAV buffer allocated: %u bytes (free PSRAM: %lu bytes)\n",
                  static_cast<unsigned>(foxie_audio::WAV_BUFFER_BYTES),
                  static_cast<unsigned long>(ESP.getFreePsram()));
  }

  if (rxHandle_ == nullptr && !initI2sRx()) {
    return false;
  }

  // Enable I2S clocks first so ES8311 PLL/state machine receives MCLK/BCLK/WS
  esp_err_t err = i2s_channel_enable(rxHandle_);
  if (err != ESP_OK) {
    Serial.printf("[Audio] i2s_channel_enable failed: %d\n", static_cast<int>(err));
    return false;
  }
  delay(10);

  if (!configureEs8311Registers()) {
    Serial.println("[Audio] ERROR: Failed to configure ES8311 registers");
    i2s_channel_disable(rxHandle_);
    return false;
  }

  // Startup probe: discard transient frame and verify live ADC samples
  delay(30);
  uint8_t probeBuf[PROBE_READ_BYTES];
  size_t probeRead = 0;
  i2s_channel_read(rxHandle_, probeBuf, sizeof(probeBuf), &probeRead, pdMS_TO_TICKS(150));
  probeRead = 0;
  i2s_channel_read(rxHandle_, probeBuf, sizeof(probeBuf), &probeRead, pdMS_TO_TICKS(150));

  int16_t peak = 0;
  uint16_t rms = 0;
  computePcmStats(probeBuf, probeRead, peak, rms);
  probeBytes_ = probeRead;
  probePeak_ = peak;
  probeRms_ = rms;
  Serial.printf("[Audio] Mic probe: read=%u B, peak=%d, rms=%u\n",
                static_cast<unsigned>(probeRead),
                peak,
                rms);

  i2s_channel_disable(rxHandle_);
  ready_ = true;
  return true;
}

void AudioRecorder::captureTaskTrampoline(void* arg) {
  static_cast<AudioRecorder*>(arg)->captureTaskLoop();
}

void AudioRecorder::captureTaskLoop() {
  taskRunning_ = true;

  while (recordingActive_ && pcmBytesWritten_ < foxie_audio::MAX_PCM_BYTES) {
    size_t remaining = foxie_audio::MAX_PCM_BYTES - pcmBytesWritten_;
    size_t toRead = (remaining < I2S_READ_CHUNK_BYTES) ? remaining : I2S_READ_CHUNK_BYTES;
    size_t bytesRead = 0;

    esp_err_t err = i2s_channel_read(
      rxHandle_,
      wavBuffer_ + foxie_audio::WAV_HEADER_SIZE + pcmBytesWritten_,
      toRead,
      &bytesRead,
      pdMS_TO_TICKS(100)
    );

    if (err == ESP_OK && bytesRead > 0) {
      pcmBytesWritten_ += static_cast<uint32_t>(bytesRead);
    }
  }

  if (pcmBytesWritten_ >= foxie_audio::MAX_PCM_BYTES) {
    reachedLimit_ = true;
    recordingActive_ = false;
  }

  captureTaskHandle_ = nullptr;
  taskRunning_ = false;
  vTaskDelete(nullptr);
}

bool AudioRecorder::startRecording() {
  if (!ready_ || rxHandle_ == nullptr || wavBuffer_ == nullptr) {
    Serial.println("[Audio] startRecording rejected: audio not ready");
    return false;
  }
  if (recordingActive_ || taskRunning_) {
    return false;
  }

  pcmBytesWritten_ = 0;
  reachedLimit_ = false;

  esp_err_t err = i2s_channel_enable(rxHandle_);
  if (err != ESP_OK) {
    Serial.printf("[Audio] i2s_channel_enable failed: %d\n", static_cast<int>(err));
    return false;
  }

  // Discard initial transient frame (~32 ms)
  uint8_t discardBuf[PROBE_READ_BYTES];
  size_t discardRead = 0;
  i2s_channel_read(rxHandle_, discardBuf, sizeof(discardBuf), &discardRead, pdMS_TO_TICKS(100));

  recordingActive_ = true;
  BaseType_t created = xTaskCreate(
    captureTaskTrampoline,
    "audio_rec",
    4096,
    this,
    3,
    &captureTaskHandle_
  );

  if (created != pdPASS) {
    recordingActive_ = false;
    i2s_channel_disable(rxHandle_);
    Serial.println("[Audio] ERROR: Failed to create audio_rec task");
    return false;
  }

  Serial.println("[Audio] Recording started");
  return true;
}

void AudioRecorder::writeWavHeader(uint32_t pcmBytes) {
  uint8_t* h = wavBuffer_;
  uint32_t byteRate =
    foxie_audio::SAMPLE_RATE * foxie_audio::CHANNELS * (foxie_audio::BITS_PER_SAMPLE / 8);
  uint16_t blockAlign = foxie_audio::CHANNELS * (foxie_audio::BITS_PER_SAMPLE / 8);

  memcpy(h + 0, "RIFF", 4);
  writeLe32(h + 4, 36 + pcmBytes);
  memcpy(h + 8, "WAVE", 4);
  memcpy(h + 12, "fmt ", 4);
  writeLe32(h + 16, 16); // PCM subchunk size
  writeLe16(h + 20, 1);  // AudioFormat = 1 (PCM)
  writeLe16(h + 22, foxie_audio::CHANNELS);
  writeLe32(h + 24, foxie_audio::SAMPLE_RATE);
  writeLe32(h + 28, byteRate);
  writeLe16(h + 32, blockAlign);
  writeLe16(h + 34, foxie_audio::BITS_PER_SAMPLE);
  memcpy(h + 36, "data", 4);
  writeLe32(h + 40, pcmBytes);
}

bool AudioRecorder::stopRecording(foxie_audio::CaptureStats& outStats) {
  outStats = {};
  if (!ready_ || wavBuffer_ == nullptr) {
    return false;
  }

  recordingActive_ = false;
  uint32_t waitStart = millis();
  while (taskRunning_ && (millis() - waitStart) < 350) {
    delay(5);
  }

  if (rxHandle_ != nullptr) {
    i2s_channel_disable(rxHandle_);
  }

  uint32_t pcmBytes = pcmBytesWritten_;
  // Keep sample alignment even (16-bit mono = 2 bytes/sample)
  pcmBytes &= ~static_cast<uint32_t>(1);
  pcmBytesWritten_ = pcmBytes;

  writeWavHeader(pcmBytes);

  uint32_t bytesPerSec =
    foxie_audio::SAMPLE_RATE * foxie_audio::CHANNELS * (foxie_audio::BITS_PER_SAMPLE / 8);
  outStats.pcmBytes = pcmBytes;
  outStats.wavBytes = static_cast<uint32_t>(foxie_audio::WAV_HEADER_SIZE) + pcmBytes;
  outStats.durationMs = (bytesPerSec > 0) ? ((pcmBytes * 1000ULL) / bytesPerSec) : 0;
  outStats.reachedLimit = reachedLimit_;
  computePcmStats(
    wavBuffer_ + foxie_audio::WAV_HEADER_SIZE,
    pcmBytes,
    outStats.peakAbs,
    outStats.rms
  );

  Serial.printf("[Audio] Recorded %lu ms (%lu B WAV, peak=%d, rms=%u)\n",
                static_cast<unsigned long>(outStats.durationMs),
                static_cast<unsigned long>(outStats.wavBytes),
                outStats.peakAbs,
                outStats.rms);
  return true;
}

void AudioRecorder::prepareForDeepSleep() {
  if (recordingActive_ || taskRunning_) {
    foxie_audio::CaptureStats discarded;
    stopRecording(discarded);
  }

  if (rxHandle_ != nullptr) {
    i2s_channel_disable(rxHandle_);
    i2s_del_channel(rxHandle_);
    rxHandle_ = nullptr;
  }

  if (ready_) {
    writeReg(0x00, 0x00);
    writeReg(0x0D, 0xFC);
    writeReg(0x0E, 0xFF);
  }

  Wire.end();
  digitalWrite(PIN_AUDIO_PA_CTRL, LOW);
  digitalWrite(PIN_AUDIO_PWR, AUDIO_PWR_OFF_LEVEL);
  ready_ = false;
}
