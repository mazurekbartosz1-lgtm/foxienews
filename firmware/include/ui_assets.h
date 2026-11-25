#pragma once

#include <stdint.h>
#include <pgmspace.h>

/**
 * UI asset contract shared between simulator/ and firmware/.
 *
 * Full 1-bit MSB-first PROGMEM bitmaps (lisek mascot states & icons) will be
 * generated/exported from the browser simulator in Etap 1A.
 */

constexpr uint16_t EPD_WIDTH = 200;
constexpr uint16_t EPD_HEIGHT = 200;
constexpr uint32_t EPD_BUFFER_BYTES = (EPD_WIDTH * EPD_HEIGHT) / 8; // 5000 bytes
