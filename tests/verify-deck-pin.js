/**
 * Deck pin / recent split rules (mirrors ace-db.js).
 * Run: node tests/verify-deck-pin.js
 */

function materialDeckPinExplicit(row) {
  if (!row || !row.content || typeof row.content !== "object") {
    return null;
  }
  if (row.content.pinned_to_deck === true) {
    return true;
  }
  if (row.content.pinned_to_deck === false) {
    return false;
  }
  return null;
}

function isMaterialPinnedToDeck(row) {
  var explicit = materialDeckPinExplicit(row);
  if (explicit === true) {
    return true;
  }
  if (explicit === false) {
    return false;
  }
  return true;
}

function isMaterialInRecent(row) {
  return materialDeckPinExplicit(row) === false;
}

var tests = [
  {
    row: { content: { pinned_to_deck: false } },
    deck: false,
    recent: true
  },
  {
    row: { content: { pinned_to_deck: true } },
    deck: true,
    recent: false
  },
  {
    row: { content: { schema: "ai_formula_sheet_v1" } },
    deck: true,
    recent: false
  },
  {
    row: { content: {} },
    deck: true,
    recent: false
  }
];

var failed = 0;

tests.forEach(function (test, index) {
  var deck = isMaterialPinnedToDeck(test.row);
  var recent = isMaterialInRecent(test.row);
  if (deck !== test.deck || recent !== test.recent) {
    failed += 1;
    console.error(
      "Case",
      index + 1,
      "expected deck=",
      test.deck,
      "recent=",
      test.recent,
      "got deck=",
      deck,
      "recent=",
      recent
    );
  }
});

if (failed) {
  process.exit(1);
}

console.log("OK: deck pin / recent rules");