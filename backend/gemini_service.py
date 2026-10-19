import json
import re
from typing import Any

from fastapi import HTTPException, status
from google import genai
from google.genai import types


EXTRACT_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "key_concepts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "explanation": {"type": "string"},
                    "example": {"type": "string"},
                },
                "required": ["title", "explanation"],
            },
        },
        "definitions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "term": {"type": "string"},
                    "definition": {"type": "string"},
                },
                "required": ["term", "definition"],
            },
        },
        "formulas": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "formula": {"type": "string"},
                    "meaning": {"type": "string"},
                    "variables": {"type": "string"},
                    "example": {"type": "string"},
                },
                "required": ["formula", "meaning"],
            },
        },
        "key_takeaways": {
            "type": "array",
            "items": {"type": "string"},
        },
        "subject": {"type": "string"},
        "difficulty": {"type": "string"},
    },
    "required": ["key_concepts", "definitions", "formulas", "key_takeaways"],
}


def _strip_code_fence(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    return cleaned.strip()


def _clean_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _normalize_concepts(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []

    concepts: list[str] = []

    for item in raw:
        if not isinstance(item, str):
            continue
        value = item.strip()
        if len(value) >= 2:
            concepts.append(value)

    return concepts


def _normalize_key_concepts(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []

    items: list[dict[str, str]] = []

    for entry in raw:
        if not isinstance(entry, dict):
            continue
        title = _clean_str(entry.get("title"))
        explanation = _clean_str(entry.get("explanation"))
        if len(title) < 2 or len(explanation) < 8:
            continue
        example = _clean_str(entry.get("example"))
        item: dict[str, str] = {"title": title, "explanation": explanation}
        if example:
            item["example"] = example
        items.append(item)

    return items[:16]


def _normalize_definitions(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []

    items: list[dict[str, str]] = []

    for entry in raw:
        if not isinstance(entry, dict):
            continue
        term = _clean_str(entry.get("term"))
        definition = _clean_str(entry.get("definition"))
        if len(term) < 2 or len(definition) < 8:
            continue
        items.append({"term": term, "definition": definition})

    return items[:24]


def _normalize_formulas(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []

    items: list[dict[str, str]] = []

    for entry in raw:
        if not isinstance(entry, dict):
            continue
        formula = _clean_str(entry.get("formula"))
        meaning = _clean_str(entry.get("meaning"))
        if len(formula) < 2 or len(meaning) < 4:
            continue
        item: dict[str, str] = {"formula": formula, "meaning": meaning}
        variables = _clean_str(entry.get("variables"))
        example = _clean_str(entry.get("example"))
        if variables:
            item["variables"] = variables
        if example:
            item["example"] = example
        items.append(item)

    return items[:16]


def _normalize_takeaways(raw: Any) -> list[str]:
    return _normalize_concepts(raw)[:20]


def derive_flat_concepts(payload: dict[str, Any]) -> list[str]:
    concepts: list[str] = []

    for item in payload.get("key_concepts", []):
        title = item.get("title")
        if title:
            concepts.append(str(title).strip())

    for item in payload.get("definitions", []):
        term = item.get("term")
        if term:
            concepts.append(str(term).strip())

    for item in payload.get("formulas", []):
        formula = item.get("formula")
        if formula:
            concepts.append(str(formula).strip())

    concepts.extend(payload.get("key_takeaways", []))

    deduped: list[str] = []
    seen: set[str] = set()

    for concept in concepts:
        key = concept.lower()
        if key and key not in seen:
            seen.add(key)
            deduped.append(concept)

    return deduped[:32]


def extraction_has_content(payload: dict[str, Any]) -> bool:
    return bool(
        payload.get("key_concepts")
        or payload.get("definitions")
        or payload.get("formulas")
        or payload.get("key_takeaways")
    )


def normalize_extraction_payload(
    parsed: dict[str, Any],
    *,
    title: str | None,
    subject: str | None,
    difficulty: str | None,
) -> dict[str, Any]:
    key_concepts = _normalize_key_concepts(parsed.get("key_concepts"))
    definitions = _normalize_definitions(parsed.get("definitions"))
    formulas = _normalize_formulas(parsed.get("formulas"))
    key_takeaways = _normalize_takeaways(parsed.get("key_takeaways"))

    payload: dict[str, Any] = {
        "title": _clean_str(parsed.get("title"))
        or _clean_str(title)
        or "Untitled study set",
        "key_concepts": key_concepts,
        "definitions": definitions,
        "formulas": formulas,
        "key_takeaways": key_takeaways,
        "subject": _clean_str(subject or parsed.get("subject")) or None,
        "difficulty": _clean_str(difficulty or parsed.get("difficulty")) or None,
    }

    payload["concepts"] = derive_flat_concepts(payload)

    return payload


def extract_concepts_with_gemini(
    *,
    api_key: str,
    model: str,
    notes: str,
    title: str | None,
    subject: str | None,
    difficulty: str | None,
) -> dict[str, Any]:
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="GEMINI_API_KEY is not configured on the server.",
        )

    prompt = (
        "You are an expert study coach creating revision material from student notes.\n\n"
        "STRICT RULES:\n"
        "- Use ONLY information supported by the notes. Do not invent facts, formulas, "
        "dates, names, or examples that are not in the notes or clearly implied for the subject.\n"
        "- Write complete explanations and definitions, not single-word headings.\n"
        "- key_concepts: 4–12 items with title, explanation (2–4 sentences), and example "
        "only when the notes provide one or a natural illustration from the notes.\n"
        "- definitions: term + complete definition sentence(s) for important terms in the notes.\n"
        "- formulas: ONLY if the notes contain equations or explicit formula relationships. "
        "Include formula, meaning, variables (if applicable), and example when present in notes. "
        "Otherwise return an empty array.\n"
        "- key_takeaways: 3–10 concise revision bullets grounded in the notes.\n"
        "- Return empty arrays for sections with no relevant content.\n"
        "- Return JSON only matching the schema.\n\n"
        f"Requested title: {title or '(none)'}\n"
        f"Requested subject: {subject or '(none)'}\n"
        f"Requested difficulty: {difficulty or '(none)'}\n\n"
        "STUDENT NOTES:\n"
        f"{notes}"
    )

    client = genai.Client(api_key=api_key)

    try:
        response = client.models.generate_content(
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=EXTRACT_JSON_SCHEMA,
                temperature=0.25,
            ),
        )
    except Exception as exc:
        message = str(exc)
        lowered = message.lower()

        if "429" in message or "quota" in lowered or "rate" in lowered:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Gemini quota or rate limit exceeded: {message}",
            ) from exc

        if "404" in message and "model" in lowered:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=(
                    f"Gemini model error (check GEMINI_MODEL in backend/.env): {message}"
                ),
            ) from exc

        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Gemini request failed: {message}",
        ) from exc

    raw_text = getattr(response, "text", None) or ""

    if not raw_text.strip():
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Gemini returned an empty response.",
        )

    try:
        parsed = json.loads(_strip_code_fence(raw_text))
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Gemini returned invalid JSON.",
        )

    if not isinstance(parsed, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Gemini returned an unexpected response shape.",
        )

    payload = normalize_extraction_payload(
        parsed,
        title=title,
        subject=subject,
        difficulty=difficulty,
    )

    if not extraction_has_content(payload):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Gemini did not return usable study material for these notes.",
        )

    return payload


CHEATSHEET_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "subject": {"type": "string"},
        "overview": {"type": "string"},
        "key_concepts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "definition": {"type": "string"},
                    "explanation": {"type": "string"},
                    "example": {"type": "string"},
                },
                "required": ["title", "definition", "explanation"],
            },
        },
        "important_definitions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "term": {"type": "string"},
                    "definition": {"type": "string"},
                },
                "required": ["term", "definition"],
            },
        },
        "formulas": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "expression": {"type": "string"},
                    "variables": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "symbol": {"type": "string"},
                                "meaning": {"type": "string"},
                            },
                            "required": ["symbol", "meaning"],
                        },
                    },
                    "example": {"type": "string"},
                },
                "required": ["name", "expression"],
            },
        },
        "key_points": {
            "type": "array",
            "items": {"type": "string"},
        },
        "examples": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "explanation": {"type": "string"},
                },
                "required": ["title", "explanation"],
            },
        },
        "quick_revision": {
            "type": "array",
            "items": {"type": "string"},
        },
    },
    "required": [
        "title",
        "overview",
        "key_concepts",
        "important_definitions",
        "formulas",
        "key_points",
        "quick_revision",
    ],
}


def _normalize_cheatsheet_concepts(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []

    items: list[dict[str, str]] = []

    for entry in raw:
        if not isinstance(entry, dict):
            continue
        title = _clean_str(entry.get("title"))
        definition = _clean_str(entry.get("definition"))
        explanation = _clean_str(entry.get("explanation"))
        if len(title) < 2 or len(definition) < 8 or len(explanation) < 8:
            continue
        item: dict[str, str] = {
            "title": title,
            "definition": definition,
            "explanation": explanation,
        }
        example = _clean_str(entry.get("example"))
        if example:
            item["example"] = example
        items.append(item)

    return items[:14]


def _normalize_formula_variables(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []

    items: list[dict[str, str]] = []

    for entry in raw:
        if not isinstance(entry, dict):
            continue
        symbol = _clean_str(entry.get("symbol"))
        meaning = _clean_str(entry.get("meaning"))
        if len(symbol) < 1 or len(meaning) < 2:
            continue
        items.append({"symbol": symbol, "meaning": meaning})

    return items[:12]


def _normalize_cheatsheet_formulas(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []

    items: list[dict[str, Any]] = []

    for entry in raw:
        if not isinstance(entry, dict):
            continue
        name = _clean_str(entry.get("name"))
        expression = _clean_str(entry.get("expression"))
        if len(name) < 2 or len(expression) < 2:
            continue
        item: dict[str, Any] = {"name": name, "expression": expression}
        variables = _normalize_formula_variables(entry.get("variables"))
        if variables:
            item["variables"] = variables
        example = _clean_str(entry.get("example"))
        if example:
            item["example"] = example
        items.append(item)

    return items[:16]


def _normalize_cheatsheet_examples(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []

    items: list[dict[str, str]] = []

    for entry in raw:
        if not isinstance(entry, dict):
            continue
        title = _clean_str(entry.get("title"))
        explanation = _clean_str(entry.get("explanation"))
        if len(title) < 2 or len(explanation) < 8:
            continue
        items.append({"title": title, "explanation": explanation})

    return items[:10]


def cheatsheet_has_content(payload: dict[str, Any]) -> bool:
    return bool(
        payload.get("key_concepts")
        or payload.get("important_definitions")
        or payload.get("formulas")
        or payload.get("key_points")
        or payload.get("quick_revision")
        or payload.get("examples")
    )


def normalize_cheatsheet_payload(
    parsed: dict[str, Any],
    *,
    title: str | None,
    subject: str | None,
) -> dict[str, Any]:
    key_concepts = _normalize_cheatsheet_concepts(parsed.get("key_concepts"))
    important_definitions = _normalize_definitions(parsed.get("important_definitions"))
    formulas = _normalize_cheatsheet_formulas(parsed.get("formulas"))
    key_points = _normalize_takeaways(parsed.get("key_points"))
    examples = _normalize_cheatsheet_examples(parsed.get("examples"))
    quick_revision = _normalize_takeaways(parsed.get("quick_revision"))

    overview = _clean_str(parsed.get("overview"))

    payload: dict[str, Any] = {
        "title": _clean_str(parsed.get("title")) or _clean_str(title) or "Study cheatsheet",
        "subject": _clean_str(subject or parsed.get("subject")) or None,
        "overview": overview,
        "key_concepts": key_concepts,
        "important_definitions": important_definitions,
        "formulas": formulas,
        "key_points": key_points,
        "examples": examples,
        "quick_revision": quick_revision,
    }

    return payload


def _generate_json_with_gemini(
    *,
    api_key: str,
    model: str,
    prompt: str,
    schema: dict[str, Any],
    temperature: float = 0.25,
) -> dict[str, Any]:
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="GEMINI_API_KEY is not configured on the server.",
        )

    client = genai.Client(api_key=api_key)

    try:
        response = client.models.generate_content(
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=schema,
                temperature=temperature,
            ),
        )
    except Exception as exc:
        message = str(exc)
        lowered = message.lower()

        if "429" in message or "quota" in lowered or "rate" in lowered:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Gemini quota or rate limit exceeded: {message}",
            ) from exc

        if "404" in message and "model" in lowered:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=(
                    f"Gemini model error (check GEMINI_MODEL in backend/.env): {message}"
                ),
            ) from exc

        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Gemini request failed: {message}",
        ) from exc

    raw_text = getattr(response, "text", None) or ""

    if not raw_text.strip():
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Gemini returned an empty response.",
        )

    try:
        parsed = json.loads(_strip_code_fence(raw_text))
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Gemini returned invalid JSON.",
        )

    if not isinstance(parsed, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Gemini returned an unexpected response shape.",
        )

    return parsed


def generate_cheatsheet_with_gemini(
    *,
    api_key: str,
    model: str,
    notes: str,
    title: str | None,
    subject: str | None,
) -> dict[str, Any]:
    prompt = (
        "You are an expert study coach building an exam-ready cheatsheet from student notes.\n\n"
        "STRICT RULES:\n"
        "- Use ONLY information supported by the notes. Do not invent facts, formulas, "
        "numerical values, dates, or examples not grounded in the notes.\n"
        "- Write complete definitions and explanations suitable for revision.\n"
        "- Avoid repeating the same sentence across sections.\n"
        "- key_concepts: 4–12 items with title, definition, explanation (2–4 sentences), "
        "and example only when helpful and supported by the notes.\n"
        "- important_definitions: precise term + definition for critical vocabulary.\n"
        "- formulas: ONLY when the notes include equations or explicit relationships. "
        "Use name, expression, variables (symbol + meaning), and example when present. "
        "Otherwise return an empty array.\n"
        "- key_points: scannable facts and relationships from the notes.\n"
        "- examples: illustrative worked examples ONLY when the notes support them.\n"
        "- quick_revision: 5–15 ultra-short bullets for last-minute review.\n"
        "- overview: 2–4 sentences introducing the topic from the notes.\n"
        "- Return empty arrays for irrelevant sections.\n"
        "- Return JSON only matching the schema.\n\n"
        f"Requested title: {title or '(none)'}\n"
        f"Requested subject: {subject or '(none)'}\n\n"
        "STUDENT NOTES:\n"
        f"{notes}"
    )

    parsed = _generate_json_with_gemini(
        api_key=api_key,
        model=model,
        prompt=prompt,
        schema=CHEATSHEET_JSON_SCHEMA,
        temperature=0.22,
    )

    payload = normalize_cheatsheet_payload(
        parsed,
        title=title,
        subject=subject,
    )

    if not cheatsheet_has_content(payload):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Gemini did not return usable cheatsheet content for these notes.",
        )

    return payload
