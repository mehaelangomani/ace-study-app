/**
 * Verifies ace-db.js MATERIAL_TYPES match sql/generated-materials-material-type-constraint.sql
 * Run: node tests/verify-material-types.js
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const aceDb = fs.readFileSync(path.join(root, "ace-db.js"), "utf8");
const sql = fs.readFileSync(
  path.join(root, "sql", "generated-materials-material-type-constraint.sql"),
  "utf8"
);

const typeBlock = aceDb.match(/var MATERIAL_TYPES = \{([\s\S]*?)\};/);

if (!typeBlock) {
  console.error("Could not parse MATERIAL_TYPES from ace-db.js");
  process.exit(1);
}

const appTypes = [];

typeBlock[1].replace(/(\w+):\s*"([^"]+)"/g, (_, key, value) => {
  appTypes.push(value);
});

const missing = appTypes.filter(type => !sql.includes("'" + type + "'"));

if (missing.length) {
  console.error(
    "SQL constraint file is missing app material_type values:",
    missing.join(", ")
  );
  process.exit(1);
}

console.log(
  "OK: all MATERIAL_TYPES values are listed in generated-materials-material-type-constraint.sql"
);
