import logging
import re
from typing import Any

from fastapi import HTTPException, status

from gemini_service import _clean_str, _generate_json_with_gemini

logger = logging.getLogger("ace.flashcard")

MAX_FLASHCARD_TOPUP_ATTEMPTS = 3

CARD_TYPES = frozenset(
    {
        "definition",
        "concept",
        "question_answer",
        "formula",
        "fill_blank",
    }
)
DIFFICULTIES = frozenset({"easy", "medium", "hard", "mixed"})
ALLOWED_CARD_COUNTS = frozenset({5, 10, 15, 20, 30})

FLASHCARD_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "cards": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "type": {"type": "string"},
                    "front": {"type": "string"},
                    "back": {"type": "string"},
                    "explanation": {"type": "string"},
                    "difficulty": {"type": "string"},
                    "source_concept": {"type": "string"},
                },
                "required": ["id", "type", "front", "back", "difficulty"],
            },
        },
    },
    "required": ["title", "cards"],
}


def _normalize_difficulty(value: Any) -> str:
    raw = _clean_str(value).lower()
    if raw in DIFFICULTIES:
        return raw
    return "medium"


def _normalize_card_type(value: Any) -> str | None:
    raw = _clean_str(value).lower().replace(" ", "_").replace("-", "_")
    aliases = {
        "definitions": "definition",
        "terminology": "definition",
        "concept_explanation": "concept",
        "concepts": "concept",
        "qa": "question_answer",
        "q_and_a": "question_answer",
        "question_and_answer": "question_answer",
        "formulas": "formula",
        "formula_application": "formula",
        "fill_in_the_blank": "fill_blank",
        "fill_in_blank": "fill_blank",
    }
    raw = aliases.get(raw, raw)
    if raw in CARD_TYPES:
        return raw
    return None


def _front_fingerprint(front: str) -> str:
    return re.sub(r"\s+", " ", front.strip().lower())


def _empty_normalize_stats() -> dict[str, int]:
    return {
        "raw_seen": 0,
        "accepted": 0,
        "rejected_type": 0,
        "rejected_front": 0,
        "rejected_back": 0,
        "rejected_duplicate": 0,
        "rejected_explanation": 0,
        "rejected_malformed": 0,
    }


def _try_normalize_card_entry(
    entry: dict[str, Any],
    *,
    allowed: set[str],
    seen_fronts: set[str],
) -> tuple[dict[str, Any] | None, str | None]:
    card_type = _normalize_card_type(entry.get("type"))
    if not card_type or card_type not in allowed:
        return None, "type"

    front = _clean_str(entry.get("front"))
    back = _clean_str(entry.get("back"))
    if len(front) < 4:
        return None, "front"
    if len(back) < 4:
        return None, "back"

    if front.lower() == back.lower():
        return None, "back"

    front_key = _front_fingerprint(front)
    if front_key in seen_fronts:
        return None, "duplicate"

    explanation = _clean_str(entry.get("explanation"))
    if explanation and len(explanation) < 6:
        return None, "explanation"

    item: dict[str, Any] = {
        "id": _clean_str(entry.get("id")) or "pending",
        "type": card_type,
        "front": front,
        "back": back,
        "difficulty": _normalize_difficulty(entry.get("difficulty")),
        "source_concept": _clean_str(entry.get("source_concept")) or None,
    }
    if explanation:
        item["explanation"] = explanation

    seen_fronts.add(front_key)
    return item, None


def _normalize_cards(
    raw: Any,
    *,
    allowed_types: list[str],
    target_count: int,
    seen_fronts: set[str] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    stats = _empty_normalize_stats()

    if not isinstance(raw, list):
        return [], stats

    allowed = {t for t in allowed_types if _normalize_card_type(t) in CARD_TYPES}
    if not allowed:
        allowed = {"definition", "concept", "question_answer"}

    normalized: list[dict[str, Any]] = []
    fronts = seen_fronts if seen_fronts is not None else set()

    for entry in raw:
        stats["raw_seen"] += 1

        if len(normalized) >= target_count:
            continue

        if not isinstance(entry, dict):
            stats["rejected_malformed"] += 1
            continue

        item, reason = _try_normalize_card_entry(
            entry,
            allowed=allowed,
            seen_fronts=fronts,
        )

        if item is None:
            if reason == "type":
                stats["rejected_type"] += 1
            elif reason == "front":
                stats["rejected_front"] += 1
            elif reason == "back":
                stats["rejected_back"] += 1
            elif reason == "duplicate":
                stats["rejected_duplicate"] += 1
            elif reason == "explanation":
                stats["rejected_explanation"] += 1
            else:
                stats["rejected_malformed"] += 1
            continue

        normalized.append(item)
        stats["accepted"] += 1

    return normalized, stats


def _renumber_card_ids(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    renumbered: list[dict[str, Any]] = []
    for index, card in enumerate(cards):
        item = dict(card)
        item["id"] = f"c{index + 1}"
        renumbered.append(item)
    return renumbered


def _merge_valid_cards(
    existing: list[dict[str, Any]],
    new_batch: list[dict[str, Any]],
    *,
    target_count: int,
) -> list[dict[str, Any]]:
    merged = existing[:]
    existing_fingerprints = {_front_fingerprint(card["front"]) for card in merged}

    for card in new_batch:
        if len(merged) >= target_count:
            break

        fingerprint = _front_fingerprint(card["front"])
        if fingerprint in existing_fingerprints:
            continue

        existing_fingerprints.add(fingerprint)
        merged.append(card)

    return merged[:target_count]


def _build_flashcard_generation_prompt(
    *,
    notes: str,
    title: str | None,
    count: int,
    difficulty: str,
    type_list: str,
    existing_cards: list[dict[str, Any]],
    topup: bool,
) -> str:
    if not topup:
        return (
            "You are an expert educator creating active-recall flashcards from student notes.\n\n"
            "STRICT RULES:\n"
            "- Use ONLY facts supported by the notes. Do not invent content.\n"
            f"- Return EXACTLY {count} cards in the cards array — no fewer.\n"
            f"- Allowed card types: {type_list}. Use only these types.\n"
            f"- Target difficulty: {difficulty} (set per-card difficulty when mixed).\n"
            "- definition: term or prompt on front, precise definition on back.\n"
            "- concept: question about a concept on front, clear explanation on back.\n"
            "- question_answer: concise question on front, accurate answer on back.\n"
            "- formula: name or when-to-use on front; formula and brief usage on back "
            "(only if notes contain formulas).\n"
            "- fill_blank: sentence with a blank on front; missing word(s) on back.\n"
            "- Front must be short and suitable for recall; back must teach without "
            "repeating the entire front verbatim.\n"
            "- Each card tests one distinct fact; no duplicate or near-duplicate fronts.\n"
            "- explanation is optional; include only when it adds learning value.\n"
            "- Preserve technical terminology from the notes.\n"
            "- Return JSON only.\n\n"
            f"Deck title hint: {title or '(derive from notes)'}\n\n"
            "STUDENT NOTES:\n"
            f"{notes}"
        )

    covered_lines = []
    for card in existing_cards[:30]:
        concept = card.get("source_concept") or card.get("front")
        if concept:
            covered_lines.append(f"- {concept}")

    covered_block = "\n".join(covered_lines) if covered_lines else "- (see prior batch)"

    return (
        "Add MORE flashcards to an in-progress deck from the same notes.\n\n"
        "STRICT RULES:\n"
        f"- Return EXACTLY {count} NEW cards in the cards array.\n"
        f"- Allowed card types: {type_list}.\n"
        f"- Target difficulty: {difficulty}.\n"
        "- Do NOT repeat topics already covered below.\n"
        "- Use ONLY facts supported by the notes.\n"
        "- Return JSON only.\n\n"
        "ALREADY COVERED (do not repeat):\n"
        f"{covered_block}\n\n"
        f"Deck title hint: {title or '(derive from notes)'}\n\n"
        "STUDENT NOTES:\n"
        f"{notes}"
    )


def normalize_requested_card_count(value: int) -> int:
    count = int(value)
    if count in ALLOWED_CARD_COUNTS:
        return count
    if count <= 7:
        return 5
    if count <= 12:
        return 10
    if count <= 17:
        return 15
    if count <= 25:
        return 20
    return 30


def generate_flashcards_with_gemini(
    *,
    api_key: str,
    model: str,
    notes: str,
    title: str | None,
    card_count: int,
    difficulty: str,
    card_types: list[str],
) -> dict[str, Any]:
    allowed_types = [
        t for t in card_types if _normalize_card_type(t) in CARD_TYPES
    ]
    if not allowed_types:
        allowed_types = ["definition", "concept", "question_answer"]

    difficulty = _normalize_difficulty(difficulty)
    count = normalize_requested_card_count(card_count)
    type_list = ", ".join(allowed_types)

    seen_fronts: set[str] = set()
    collected: list[dict[str, Any]] = []
    deck_title = _clean_str(title) or "Flashcard deck"
    topup_attempts = 0

    logger.info(
        "flashcard generation start requested_count=%s difficulty=%s types=%s",
        count,
        difficulty,
        type_list,
    )

    while len(collected) < count and topup_attempts <= MAX_FLASHCARD_TOPUP_ATTEMPTS:
        needed = count - len(collected)
        is_topup = topup_attempts > 0

        prompt = _build_flashcard_generation_prompt(
            notes=notes,
            title=title,
            count=needed,
            difficulty=difficulty,
            type_list=type_list,
            existing_cards=collected,
            topup=is_topup,
        )

        parsed = _generate_json_with_gemini(
            api_key=api_key,
            model=model,
            prompt=prompt,
            schema=FLASHCARD_JSON_SCHEMA,
            temperature=0.33 if not is_topup else 0.39,
        )

        if not is_topup:
            deck_title = (
                _clean_str(parsed.get("title")) or _clean_str(title) or "Flashcard deck"
            )

        raw_cards = parsed.get("cards")
        batch, batch_stats = _normalize_cards(
            raw_cards,
            allowed_types=allowed_types,
            target_count=needed,
            seen_fronts=seen_fronts,
        )

        logger.info(
            "flashcard generation batch attempt=%s raw=%s accepted=%s "
            "rejected_type=%s rejected_front=%s rejected_back=%s "
            "rejected_duplicate=%s rejected_explanation=%s",
            topup_attempts,
            batch_stats["raw_seen"],
            batch_stats["accepted"],
            batch_stats["rejected_type"],
            batch_stats["rejected_front"],
            batch_stats["rejected_back"],
            batch_stats["rejected_duplicate"],
            batch_stats["rejected_explanation"],
        )

        collected = _merge_valid_cards(
            collected,
            batch,
            target_count=count,
        )

        logger.info(
            "flashcard generation progress attempt=%s collected=%s target=%s",
            topup_attempts,
            len(collected),
            count,
        )

        if len(collected) >= count:
            break

        topup_attempts += 1

    if len(collected) < count:
        logger.warning(
            "flashcard generation incomplete requested=%s available=%s topup_attempts=%s",
            count,
            len(collected),
            topup_attempts,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(
                f"Could only generate {len(collected)} of {count} valid flashcards "
                "from these notes. Try fewer cards or add more study content."
            ),
        )

    cards = _renumber_card_ids(collected[:count])

    logger.info(
        "flashcard generation complete requested=%s final=%s topup_attempts=%s",
        count,
        len(cards),
        topup_attempts,
    )

    return {
        "title": deck_title,
        "cards": cards,
        "card_count": count,
        "requested_count": count,
    }
