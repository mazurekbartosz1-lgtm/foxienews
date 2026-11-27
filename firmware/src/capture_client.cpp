#include "capture_client.h"

#include <ArduinoJson.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <mbedtls/base64.h>
#include <memory>
#include <new>
#include <stdio.h>
#include <string.h>

#ifndef FOXIE_DEVICE_SOURCE
#define FOXIE_DEVICE_SOURCE "waveshare-154"
#endif

namespace {

constexpr size_t RAW_B64_CHUNK_BYTES = 3072; // Multiple of 3 -> 4096 bytes Base64 output
constexpr uint32_t SOCKET_WRITE_TIMEOUT_MS = 15000;
constexpr uint32_t HTTP_RESPONSE_TIMEOUT_MS = 60000;
constexpr size_t MAX_RESPONSE_BODY_BYTES = 2048;

struct ParsedEndpoint {
  bool valid = false;
  bool useTls = false;
  String host;
  uint16_t port = 0;
  String path;
};

void setShortError(CaptureUploadResult& res, const char* msg) {
  snprintf(res.shortError, sizeof(res.shortError), "%s", msg);
}

ParsedEndpoint parseCaptureUrl(const String& rawUrl) {
  ParsedEndpoint out;
  String url = rawUrl;
  url.trim();
  if (url.isEmpty()) {
    return out;
  }

  int schemeEnd = -1;
  if (url.startsWith("https://")) {
    out.useTls = true;
    out.port = 443;
    schemeEnd = 8;
  } else if (url.startsWith("http://")) {
    out.useTls = false;
    out.port = 80;
    schemeEnd = 7;
  } else {
    return out;
  }

  String rest = url.substring(schemeEnd);
  int slashIdx = rest.indexOf('/');
  String hostPort = (slashIdx >= 0) ? rest.substring(0, slashIdx) : rest;
  String path = (slashIdx >= 0) ? rest.substring(slashIdx) : "/";

  int queryIdx = path.indexOf('?');
  if (queryIdx >= 0) {
    path = path.substring(0, queryIdx);
  }

  int colonIdx = hostPort.indexOf(':');
  if (colonIdx >= 0) {
    out.host = hostPort.substring(0, colonIdx);
    long parsedPort = hostPort.substring(colonIdx + 1).toInt();
    if (parsedPort <= 0 || parsedPort > 65535) {
      return out;
    }
    out.port = static_cast<uint16_t>(parsedPort);
  } else {
    out.host = hostPort;
  }

  out.host.trim();
  if (out.host.isEmpty()) {
    return out;
  }

  if (path.isEmpty() || path == "/") {
    path = "/api/capture";
  } else if (!path.endsWith("/api/capture")) {
    while (path.endsWith("/")) {
      path.remove(path.length() - 1);
    }
    path += "/api/capture";
  }

  out.path = path;
  out.valid = true;
  return out;
}

bool writeAll(Client& client, const uint8_t* data, size_t len, uint32_t timeoutMs) {
  size_t sent = 0;
  uint32_t lastProgressMs = millis();

  while (sent < len) {
    size_t n = client.write(data + sent, len - sent);
    if (n > 0) {
      sent += n;
      lastProgressMs = millis();
    } else {
      if (!client.connected()) {
        return false;
      }
      if ((millis() - lastProgressMs) >= timeoutMs) {
        return false;
      }
      delay(5);
    }
  }
  return true;
}

bool writeAllStr(Client& client, const String& s, uint32_t timeoutMs) {
  return writeAll(
    client,
    reinterpret_cast<const uint8_t*>(s.c_str()),
    s.length(),
    timeoutMs
  );
}

String readLineWithTimeout(Client& client, uint32_t timeoutMs) {
  String line;
  uint32_t startMs = millis();
  while ((millis() - startMs) < timeoutMs) {
    while (client.available() > 0) {
      int ch = client.read();
      if (ch < 0) break;
      if (ch == '\r') continue;
      if (ch == '\n') {
        return line;
      }
      if (line.length() < 512) {
        line += static_cast<char>(ch);
      }
    }
    if (!client.connected()) {
      break;
    }
    delay(10);
  }
  return line;
}

} // namespace

CaptureUploadResult uploadWavCapture(
  const String& apiUrl,
  const String& apiKey,
  const uint8_t* wavData,
  size_t wavSize,
  UploadProgressCb onProgress
) {
  CaptureUploadResult res;

  if (WiFi.status() != WL_CONNECTED) {
    res.errorMessage = "Wi-Fi is not connected";
    setShortError(res, "BRAK WI-FI");
    return res;
  }

  if (wavData == nullptr || wavSize <= 44) {
    res.errorMessage = "Empty WAV buffer";
    setShortError(res, "PUSTE AUDIO");
    return res;
  }

  String trimmedUrl = apiUrl;
  trimmedUrl.trim();
  if (trimmedUrl.isEmpty() || trimmedUrl.indexOf("your-project-id") >= 0) {
    res.errorMessage = "API URL not configured";
    setShortError(res, "BRAK API URL");
    return res;
  }

  ParsedEndpoint ep = parseCaptureUrl(trimmedUrl);
  if (!ep.valid) {
    res.errorMessage = "Invalid API URL";
    setShortError(res, "ZLY URL API");
    return res;
  }

  Serial.printf("[Capture] Uploading %u B WAV (RSSI %d dBm) to %s://%s:%u%s\n",
                static_cast<unsigned>(wavSize),
                WiFi.RSSI(),
                ep.useTls ? "https" : "http",
                ep.host.c_str(),
                ep.port,
                ep.path.c_str());

  std::unique_ptr<WiFiClientSecure> tlsClient;
  std::unique_ptr<WiFiClient> plainClient;
  Client* client = nullptr;

  if (ep.useTls) {
    tlsClient.reset(new (std::nothrow) WiFiClientSecure());
    if (!tlsClient) {
      res.errorMessage = "Out of memory (tlsClient)";
      setShortError(res, "BRAK RAM");
      return res;
    }
    tlsClient->setInsecure();
    tlsClient->setTimeout(HTTP_RESPONSE_TIMEOUT_MS / 1000);
    tlsClient->setHandshakeTimeout(15);
    client = tlsClient.get();
  } else {
    plainClient.reset(new (std::nothrow) WiFiClient());
    if (!plainClient) {
      res.errorMessage = "Out of memory (plainClient)";
      setShortError(res, "BRAK RAM");
      return res;
    }
    plainClient->setTimeout(HTTP_RESPONSE_TIMEOUT_MS / 1000);
    client = plainClient.get();
  }

  if (!client->connect(ep.host.c_str(), ep.port)) {
    res.errorMessage = "TCP/TLS connect failed";
    setShortError(res, "BRAK POLACZ.");
    Serial.println("[Capture] ERROR: Connection failed");
    return res;
  }

  String jsonPrefix = F("{\"source\":\"");
  jsonPrefix += F(FOXIE_DEVICE_SOURCE);
  jsonPrefix += F("\",\"mimeType\":\"audio/wav\",\"audioBase64\":\"");
  const char jsonSuffix[] = "\"}";

  size_t base64Len = ((wavSize + 2) / 3) * 4;
  size_t contentLength = jsonPrefix.length() + base64Len + 2;

  String headers;
  headers.reserve(256);
  headers += F("POST ");
  headers += ep.path;
  headers += F(" HTTP/1.1\r\nHost: ");
  headers += ep.host;
  if ((ep.useTls && ep.port != 443) || (!ep.useTls && ep.port != 80)) {
    headers += ':';
    headers += String(ep.port);
  }
  headers += F("\r\nContent-Type: application/json\r\n");
  if (!apiKey.isEmpty()) {
    headers += F("X-API-Key: ");
    headers += apiKey;
    headers += F("\r\n");
  }
  headers += F("Content-Length: ");
  headers += String(static_cast<unsigned long>(contentLength));
  headers += F("\r\nConnection: close\r\n\r\n");

  if (!writeAllStr(*client, headers, SOCKET_WRITE_TIMEOUT_MS) ||
      !writeAllStr(*client, jsonPrefix, SOCKET_WRITE_TIMEOUT_MS)) {
    client->stop();
    res.errorMessage = "Socket write failed (headers)";
    setShortError(res, "BLAD WYSYLKI");
    return res;
  }

  constexpr size_t B64_BUF_SIZE = 4096 + 4;
  std::unique_ptr<uint8_t[]> b64Out(new (std::nothrow) uint8_t[B64_BUF_SIZE]);
  if (!b64Out) {
    client->stop();
    res.errorMessage = "Out of memory (b64Out)";
    setShortError(res, "BRAK RAM");
    return res;
  }
  size_t offset = 0;
  uint8_t lastPct = 30;

  while (offset < wavSize) {
    size_t chunk = wavSize - offset;
    if (chunk > RAW_B64_CHUNK_BYTES) {
      chunk = RAW_B64_CHUNK_BYTES;
    }

    size_t outLen = 0;
    int rc = mbedtls_base64_encode(
      b64Out.get(),
      B64_BUF_SIZE,
      &outLen,
      wavData + offset,
      chunk
    );
    if (rc != 0 || outLen == 0) {
      client->stop();
      res.errorMessage = "Base64 encode failed";
      setShortError(res, "BLAD BASE64");
      return res;
    }

    if (!writeAll(*client, b64Out.get(), outLen, SOCKET_WRITE_TIMEOUT_MS)) {
      client->stop();
      res.errorMessage = "Socket write failed (body)";
      setShortError(res, "BLAD WYSYLKI");
      Serial.printf("[Capture] Write error at %u/%u B (wifi=%d)\n",
                    static_cast<unsigned>(offset),
                    static_cast<unsigned>(wavSize),
                    static_cast<int>(WiFi.status()));
      return res;
    }

    offset += chunk;
    delay(2);
    if (onProgress != nullptr) {
      uint8_t pct = static_cast<uint8_t>(30 + ((offset * 55ULL) / wavSize));
      if (pct >= lastPct + 20) {
        lastPct = pct;
        onProgress(pct);
      }
    }
  }

  if (!writeAll(
        *client,
        reinterpret_cast<const uint8_t*>(jsonSuffix),
        2,
        SOCKET_WRITE_TIMEOUT_MS
      )) {
    client->stop();
    res.errorMessage = "Socket write failed (tail)";
    setShortError(res, "BLAD WYSYLKI");
    return res;
  }

  if (onProgress != nullptr) {
    onProgress(90);
  }

  String statusLine = readLineWithTimeout(*client, HTTP_RESPONSE_TIMEOUT_MS);
  statusLine.trim();
  if (statusLine.isEmpty()) {
    client->stop();
    res.errorMessage = "HTTP response timeout";
    setShortError(res, "TIMEOUT");
    Serial.printf("[Capture] ERROR: HTTP response timeout (wifi=%d)\n",
                  static_cast<int>(WiFi.status()));
    return res;
  }

  int sp1 = statusLine.indexOf(' ');
  if (sp1 >= 0) {
    res.httpStatus = statusLine.substring(sp1 + 1).toInt();
  }

  // Consume response headers until blank line
  uint32_t hdrStart = millis();
  while ((millis() - hdrStart) < 5000) {
    String hdrLine = readLineWithTimeout(*client, 5000);
    if (hdrLine.isEmpty()) {
      break;
    }
  }

  // Read response body (bounded to 2 KiB)
  String rawBody;
  rawBody.reserve(512);
  uint32_t bodyWaitStart = millis();
  while (rawBody.length() < MAX_RESPONSE_BODY_BYTES && (millis() - bodyWaitStart) < 3000) {
    bool gotData = false;
    while (client->available() > 0 && rawBody.length() < MAX_RESPONSE_BODY_BYTES) {
      int ch = client->read();
      if (ch < 0) break;
      rawBody += static_cast<char>(ch);
      gotData = true;
    }
    if (gotData) {
      bodyWaitStart = millis();
    } else if (!client->connected()) {
      break;
    } else {
      delay(10);
    }
  }
  client->stop();

  // Extract JSON object (resilient to HTTP/1.1 chunked framing sizes)
  int jsonStart = rawBody.indexOf('{');
  int jsonEnd = rawBody.lastIndexOf('}');
  String jsonBody =
    (jsonStart >= 0 && jsonEnd > jsonStart) ? rawBody.substring(jsonStart, jsonEnd + 1) : rawBody;

  JsonDocument doc;
  DeserializationError jsonErr = deserializeJson(doc, jsonBody);

  if ((res.httpStatus == 200 || res.httpStatus == 201) && !jsonErr && doc["ok"] == true) {
    res.ok = true;
    res.remotePath = doc["path"] | "";
    res.noteTitle = doc["title"] | "";
    Serial.printf("[Capture] OK (%d): %s (%s)\n",
                  res.httpStatus,
                  res.remotePath.c_str(),
                  res.noteTitle.c_str());
    return res;
  }

  if (!jsonErr && doc["error"].is<const char*>()) {
    res.errorMessage = doc["error"].as<const char*>();
  } else {
    res.errorMessage = statusLine;
  }

  if (res.httpStatus > 0) {
    char buf[24];
    snprintf(buf, sizeof(buf), "HTTP %d", res.httpStatus);
    setShortError(res, buf);
  } else {
    setShortError(res, "BLAD HTTP");
  }

  Serial.printf("[Capture] FAILED (%d): %s\n", res.httpStatus, res.errorMessage.c_str());
  return res;
}
