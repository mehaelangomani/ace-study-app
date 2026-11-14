/**
 * Frontend extract timeout should exceed backend wall clock default (180s).
 * Run: node tests/verify-extract-timeout.js
 */

const fs = require("fs");
const path = require("path");

const dashboard = fs.readFileSync(
  path.join(__dirname, "..", "dashboard.js"),
  "utf8"
);

const gemini = fs.readFileSync(
  path.join(__dirname, "..", "backend", "gemini_service.py"),
  "utf8"
);

const frontMatch = dashboard.match(
  /ACE_EXTRACT_REQUEST_TIMEOUT_MS\s*=\s*(\d+)/
);
if (!frontMatch) {
  console.error("ACE_EXTRACT_REQUEST_TIMEOUT_MS not found in dashboard.js");
  process.exit(1);
}

const wallMatch = gemini.match(
  /GEMINI_RETRY_MAX_WALL_SECONDS[^\d]*(\d+)/
);
if (!wallMatch) {
  console.error("GEMINI_RETRY_MAX_WALL_SECONDS default not found");
  process.exit(1);
}

const frontMs = Number(frontMatch[1]);
const backendSec = Number(wallMatch[1]);

if (frontMs <= backendSec * 1000) {
  console.error(
    "Frontend timeout must be greater than backend wall clock:",
    frontMs,
    "vs",
    backendSec * 1000
  );
  process.exit(1);
}

if (!dashboard.includes("fetchExtractWithTimeout")) {
  console.error("fetchExtractWithTimeout helper missing");
  process.exit(1);
}

if (!dashboard.includes('error.name === "AbortError"')) {
  console.error("AbortError handling missing in runExtraction");
  process.exit(1);
}

console.log("OK: extract timeout wiring");