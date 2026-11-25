#pragma once

/**
 * Pin definitions for Waveshare ESP32-S3-Touch-ePaper-1.54 (Hardware V2)
 * MCU: ESP32-S3-PICO-1-N8R8 (8 MB QSPI Flash, 8 MB OPI PSRAM)
 *
 * IMPORTANT: Verify against Waveshare's official V2 schematic PDF before
 * flashing audio/display drivers if any hardware sub-revision differs.
 */

// --- 1.54" e-Paper Display (200x200 px, SPI) ---
constexpr int PIN_EPD_PWR  = 6;
constexpr int PIN_EPD_BUSY = 8;
constexpr int PIN_EPD_RST  = 9;
constexpr int PIN_EPD_DC   = 10;
constexpr int PIN_EPD_CS   = 11;
constexpr int PIN_EPD_SCK  = 12;
constexpr int PIN_EPD_MOSI = 13;

// --- Shared I2C Bus (ES8311 Codec, PCF85063 RTC, SHTC3 Sensor, FT6336 Touch) ---
// NOTE: On the rear 2x6 expansion header sticker, SDA/SCL are in the left column
// while GP20/GP19 are in the right column. GP19/GP20 are native USB D-/D+ lines
// on ESP32-S3 and must NOT be repurposed as I2C.
constexpr int PIN_I2C_SDA = 47;
constexpr int PIN_I2C_SCL = 48;

// --- Audio Codec ES8311 (I2S + Amp Power) ---
constexpr int PIN_I2S_MCLK  = 14;
constexpr int PIN_I2S_BCLK  = 15;
constexpr int PIN_I2S_DIN   = 16; // Mic data from ES8311 to ESP32-S3
constexpr int PIN_I2S_WS    = 38; // LRCK / Word Select
constexpr int PIN_I2S_DOUT  = 45; // Speaker data from ESP32-S3 to ES8311
constexpr int PIN_AUDIO_PWR = 42; // Audio amplifier power enable

// --- Buttons, Power Latch & Status LED ---
constexpr int PIN_BTN_BOOT   = 0;  // Active LOW (also USB download strapping pin)
constexpr int PIN_BTN_PWR    = 18; // Physical PWR side button
constexpr int PIN_PWR_HOLD   = 17; // Must be driven HIGH early in setup() on LiPo battery
constexpr int PIN_LED_STATUS = 3;  // Status LED (GP3)
constexpr int PIN_BAT_ADC    = 4;  // Battery voltage divider ADC (GP4)
constexpr int PIN_RTC_INT    = 5;  // PCF85063 RTC interrupt

// --- MicroSD Slot (1-bit SDMMC) ---
constexpr int PIN_SD_CLK = 39;
constexpr int PIN_SD_D0  = 40;
constexpr int PIN_SD_CMD = 41;
