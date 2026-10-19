import logging
import re
from typing import Any

from fastapi import HTTPException, status

from gemini_service import _clean_str, _generate_json_with_gemini

logger = logging.getLogger("ace.formula_sheet")

FORMULA_SHEET_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "subject": {"type": "string"},
        "overview": {"type": "string"},
        "categories": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "formulas": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "name": {"type": "string"},
                                "expression": {"type": "string"},
                                "description": {"type": "string"},
                                "variables": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "symbol": {"type": "string"},
                                            "meaning": {"type": "string"},
                                            "unit": {"type": "string"},
                                        },
                                    },
                                },
                                "conditions": {"type": "string"},
                                "example": {
                                    "type": "object",
                                    "properties": {
                                        "problem": {"type": "string"},
                                        "steps": {
                                            "type": "array",
                                            "items": {"type": "string"},
                                        },
                                        "answer": {"type": "string"},
                                    },
                                },
                                "source_concept": {"type": "string"},
                            },
                            "required": ["name", "expression", "description"],
                        },
                    },
                },
                "required": ["name", "formulas"],
            },
        },
        "quick_reference": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "expression": {"type": "string"},
                    "usage": {"type": "string"},
                },
            },
        },
    },
    "required": ["title", "categories", "quick_reference"],
}


def _expression_fingerprint(expression: str) -> str:
    return re.sub(r"\s+", "", expression.strip().lower())


def _normalize_variables(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []

    items: list[dict[str, str]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        symbol = _clean_str(entry.get("symbol"))
        meaning = _clean_str(entry.get("meaning"))
        unit = _clean_str(entry.get("unit"))
        if not symbol or not meaning:
            continue
        item: dict[str, str] = {"symbol": symbol, "meaning": meaning}
        if unit:
            item["unit"] = unit
        items.append(item)
    return items[:24]


def _normalize_example(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None

    problem = _clean_str(raw.get("problem"))
    answer = _clean_str(raw.get("answer"))
    steps_raw = raw.get("steps")
    steps: list[str] = []
    if isinstance(steps_raw, list):
        for step in steps_raw:
            text = _clean_str(step)
            if text:
                steps.append(text)

    if not problem and not steps and not answer:
        return None

    return {
        "problem": problem or None,
        "steps": steps[:12],
        "answer": answer or None,
    }


def _normalize_formula_entry(
    entry: dict[str, Any],
    *,
    seen_expressions: set[str],
    formula_index: int,
) -> dict[str, Any] | None:
    name = _clean_str(entry.get("name"))
    expression = _clean_str(entry.get("expression"))
    description = _clean_str(entry.get("description"))

    if len(name) < 2 or len(expression) < 2 or len(description) < 8:
        return None

    fingerprint = _expression_fingerprint(expression)
    if fingerprint in seen_expressions:
        return None
    seen_expressions.add(fingerprint)

    formula_id = _clean_str(entry.get("id")) or f"f{formula_index + 1}"
    conditions = _clean_str(entry.get("conditions"))
    example = _normalize_example(entry.get("example"))

    item: dict[str, Any] = {
        "id": formula_id,
        "name": name,
        "expression": expression,
        "description": description,
        "variables": _normalize_variables(entry.get("variables")),
        "source_concept": _clean_str(entry.get("source_concept")) or None,
    }
    if conditions:
        item["conditions"] = conditions
    if example:
        item["example"] = example
    return item


def normalize_formula_sheet_payload(
    parsed: dict[str, Any],
    *,
    title: str | None,
) -> dict[str, Any]:
    seen_expressions: set[str] = set()
    categories_out: list[dict[str, Any]] = []
    formula_counter = 0

    raw_categories = parsed.get("categories")
    if isinstance(raw_categories, list):
        for cat in raw_categories:
            if not isinstance(cat, dict):
                continue
            cat_name = _clean_str(cat.get("name")) or "General"
            formulas_in: list[dict[str, Any]] = []
            raw_formulas = cat.get("formulas")
            if isinstance(raw_formulas, list):
                for entry in raw_formulas:
                    if not isinstance(entry, dict):
                        continue
                    normalized = _normalize_formula_entry(
                        entry,
                        seen_expressions=seen_expressions,
                        formula_index=formula_counter,
                    )
                    if normalized is None:
                        continue
                    formulas_in.append(normalized)
                    formula_counter += 1
            if formulas_in:
                categories_out.append({"name": cat_name, "formulas": formulas_in})

    quick_out: list[dict[str, str]] = []
    raw_quick = parsed.get("quick_reference")
    if isinstance(raw_quick, list):
        for entry in raw_quick:
            if not isinstance(entry, dict):
                continue
            q_name = _clean_str(entry.get("name"))
            q_expr = _clean_str(entry.get("expression"))
            q_usage = _clean_str(entry.get("usage"))
            if len(q_name) < 2 or len(q_expr) < 2:
                continue
            quick_out.append(
                {
                    "name": q_name,
                    "expression": q_expr,
                    "usage": q_usage or "",
                }
            )

    return {
        "title": _clean_str(parsed.get("title")) or _clean_str(title) or "Formula sheet",
        "subject": _clean_str(parsed.get("subject")) or None,
        "overview": _clean_str(parsed.get("overview")) or "",
        "categories": categories_out,
        "quick_reference": quick_out[:20],
        "formula_count": formula_counter,
    }


def formula_sheet_has_formulas(payload: dict[str, Any]) -> bool:
    return int(payload.get("formula_count") or 0) > 0


def generate_formula_sheet_with_gemini(
    *,
    api_key: str,
    model: str,
    notes: str,
    title: str | None,
    subject: str | None = None,
) -> dict[str, Any]:
    prompt = (
        "You are an expert educator building a formula sheet from student notes.\n\n"
        "STRICT RULES:\n"
        "- Include ONLY formulas and equations supported by the notes.\n"
        "- Do NOT invent formulas, constants, units, or numerical values.\n"
        "- If the notes contain no real formulas, return empty categories and "
        "quick_reference arrays.\n"
        "- Group formulas into sensible categories.\n"
        "- Each formula needs: name, expression, description (8+ chars), variables "
        "with symbol and meaning.\n"
        "- conditions only when stated or clearly implied in notes.\n"
        "- example only when the notes support a worked calculation; show steps.\n"
        "- Preserve mathematical notation (LaTeX-style OK in expression fields).\n"
        "- Avoid duplicate expressions under different names.\n"
        "- quick_reference: up to 8 compact items from the same notes.\n"
        "- Return JSON only.\n\n"
        f"Title hint: {title or '(derive from notes)'}\n"
        f"Subject hint: {subject or '(derive if clear)'}\n\n"
        "STUDENT NOTES:\n"
        f"{notes}"
    )

    parsed = _generate_json_with_gemini(
        api_key=api_key,
        model=model,
        prompt=prompt,
        schema=FORMULA_SHEET_JSON_SCHEMA,
        temperature=0.28,
    )

    payload = normalize_formula_sheet_payload(parsed, title=title)

    logger.info(
        "formula sheet generation formulas=%s categories=%s",
        payload.get("formula_count"),
        len(payload.get("categories") or []),
    )

    if not formula_sheet_has_formulas(payload):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "No extractable formulas were found in these notes. "
                "Try a study set with equations, science, or math content."
            ),
        )

    return payload
