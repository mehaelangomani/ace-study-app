import json
import logging
import os
import re
import time
from typing import Any

from fastapi import HTTPException, status
from google import genai
from google.genai import types

logger = logging.getLogger("ace.gemini")

MAX_GEMINI_RETRIES = 3
_GEMINI_RETRY_BASE_SECONDS = 1.0

GEMINI_SINGLE_REQUEST_TIMEOUT_SECONDS = float(
    os.getenv("GEMINI_REQUEST_TIMEOUT_SECONDS", "90")
)
GEMINI_RETRY_MAX_WALL_SECONDS = float(
    os.getenv("GEMINI_RETRY_MAX_WALL_SECONDS", "180")
)


def _gemini_error_message(exc: BaseException) -> str:
    return (str(exc) or exc.__class__.__name__).strip()


def _sanitize_client_error_detail(message: str) -> str:
    lowered = message.lower()
    if "api key" in lowered or "api_key" in lowered:
        return (
            "Gemini authentication failed on the server. "
            "Check GEMINI_API_KEY configuration."
        )
    if len(message) > 480:
        return message[:477] + "..."
    return message


def _is_gemini_non_retryable(message: str, lowered: str) -> bool:
    markers = (
        "invalid api key",
        "api key not valid",
        "api_key_invalid",
        "permission denied",
        "unauthenticated",
        "unauthorized",
        "invalid_argument",
        "bad request",
    )
    if any(marker in lowered for marker in markers):
        return True
    if "401" in message:
        return True
    if "403" in message and "forbidden" in lowered:
        return True
    if "404" in message and "model" in lowered:
        return True
    return False


def _is_gemini_retryable(
    message: str,
    lowered: str,
    exc: BaseException | None = None,
) -> bool:
    if _is_gemini_non_retryable(message, lowered):
        return False
    if exc is not None and exc.__class__.__name__ in (
        "ServerError",
        "ServiceUnavailable",
        "DeadlineExceeded",
        "TimeoutError",
    ):
        return True
    if isinstance(exc, TimeoutError):
        return True
    if "429" in message or "rate limit" in lowered or "quota" in lowered:
        return True
    if "503" in message or "unavailable" in lowered or "high demand" in lowered:
        return True
    if "500" in message or "internal error" in lowered or "servererror" in lowered:
        return True
    if "deadline exceeded" in lowered or "timed out" in lowered or "timeout" in lowered:
        return True
    return False


def _http_exception_for_gemini_failure(exc: BaseException) -> HTTPException:
    message = _gemini_error_message(exc)
    lowered = message.lower()
    detail = _sanitize_client_error_detail(message)

    if isinstance(exc, TimeoutError) or exc.__class__.__name__ == "TimeoutError":
        return HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=(
                "The Gemini request timed out. Try again with shorter notes "
                "or wait a moment."
            ),
        )

    if _is_gemini_non_retryable(message, lowered):
        if "404" in message and "model" in lowered:
            return HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=(
                    "Gemini model error. Check GEMINI_MODEL in backend/.env. "
                    + _sanitize_client_error_detail(message)
                ),
            )
        if "401" in message or "invalid api key" in lowered or "api key not valid" in lowered:
            return HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=_sanitize_client_error_detail(
                    "Gemini rejected the configured API key."
                ),
            )
        return HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=detail or "Gemini request was rejected.",
        )

    if "429" in message or "rate limit" in lowered or "quota" in lowered:
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Gemini rate limit was reached. Wait a moment and try again."
            ),
        )

    if (
        "503" in message
        or "unavailable" in lowered
        or "high demand" in lowered
        or "500" in message
    ):
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Gemini is temporarily unavailable due to high demand. "
                "Please try again in a few moments."
            ),
        )

    if "deadline exceeded" in lowered or "timed out" in lowered or "timeout" in lowered:
        return HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=(
                "The Gemini request timed out. Try again with shorter notes "
                "or wait a moment."
            ),
        )

    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail=detail or "Gemini request failed.",
    )


def _gemini_client_for_attempt(api_key: str, timeout_seconds: float) -> genai.Client:
    """SDK HTTP timeout (ms) bounds the blocking socket read; no orphan threads."""
    timeout_ms = max(1000, int(timeout_seconds * 1000))
    return genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(timeout=timeout_ms),
    )


def _invoke_generate_content(
    client: genai.Client,
    *,
    model: str,
    contents: str,
    config: types.GenerateContentConfig,
) -> Any:
    return client.models.generate_content(
        model=model,
        contents=contents,
        config=config,
    )


def _generate_content_with_retry(
    *,
    api_key: str,
    model: str,
    contents: str,
    config: types.GenerateContentConfig,
    operation: str = "gemini",
) -> Any:
    last_exc: BaseException | None = None
    deadline = time.monotonic() + GEMINI_RETRY_MAX_WALL_SECONDS

    logger.info(
        "%s start model=%s max_attempts=%s per_call_timeout_seconds=%.0f max_wall_seconds=%.0f",
        operation,
        model,
        MAX_GEMINI_RETRIES + 1,
        GEMINI_SINGLE_REQUEST_TIMEOUT_SECONDS,
        GEMINI_RETRY_MAX_WALL_SECONDS,
    )

    for attempt in range(MAX_GEMINI_RETRIES + 1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            logger.warning(
                "%s wall clock exceeded before attempt=%s",
                operation,
                attempt + 1,
            )
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                detail=(
                    "The Gemini request timed out after multiple attempts. "
                    "Try again with shorter notes or wait a moment."
                ),
            )

        per_call_timeout = min(
            GEMINI_SINGLE_REQUEST_TIMEOUT_SECONDS,
            max(1.0, remaining),
        )

        try:
            client = _gemini_client_for_attempt(api_key, per_call_timeout)
            result = _invoke_generate_content(
                client,
                model=model,
                contents=contents,
                config=config,
            )
            logger.info("%s success attempt=%s", operation, attempt + 1)
            return result
        except Exception as exc:
            message = _gemini_error_message(exc)
            lowered = message.lower()
            if (
                "timeout" in lowered
                or "timed out" in lowered
                or exc.__class__.__name__ in ("APITimeoutError", "TimeoutException")
            ):
                last_exc = TimeoutError(
                    f"Gemini call exceeded {per_call_timeout:.0f}s"
                )
                logger.warning(
                    "%s attempt timeout attempt=%s timeout_seconds=%.1f error_class=%s",
                    operation,
                    attempt + 1,
                    per_call_timeout,
                    exc.__class__.__name__,
                )
            else:
                last_exc = exc

        if last_exc is None:
            continue

        message = _gemini_error_message(last_exc)
        lowered = message.lower()

        if not _is_gemini_retryable(message, lowered, last_exc):
            logger.warning(
                "%s non-retryable failure attempt=%s error_class=%s",
                operation,
                attempt + 1,
                last_exc.__class__.__name__,
            )
            raise _http_exception_for_gemini_failure(last_exc) from last_exc

        if attempt >= MAX_GEMINI_RETRIES:
            logger.warning(
                "%s retries exhausted attempts=%s error_class=%s",
                operation,
                attempt + 1,
                last_exc.__class__.__name__,
            )
            break

        delay = _GEMINI_RETRY_BASE_SECONDS * (2**attempt)
        if time.monotonic() + delay > deadline:
            logger.warning(
                "%s wall clock exceeded during backoff attempt=%s",
                operation,
                attempt + 1,
            )
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                detail=(
                    "The Gemini request timed out after multiple attempts. "
                    "Try again with shorter notes or wait a moment."
                ),
            ) from last_exc

        logger.warning(
            "%s transient error attempt=%s max_attempts=%s retry_in_seconds=%.1f error_class=%s",
            operation,
            attempt + 1,
            MAX_GEMINI_RETRIES + 1,
            delay,
            last_exc.__class__.__name__,
        )
        time.sleep(delay)

    if last_exc is not None:
        logger.warning("%s final failure error_class=%s", operation, last_exc.__class__.__name__)
        raise _http_exception_for_gemini_failure(last_exc) from last_exc

    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="Gemini request failed.",
    )


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

    logger.info(
        "extract gemini start notes_length=%s title_present=%s",
        len(notes),
        bool(title and str(title).strip()),
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

    parsed = _generate_json_with_gemini(
        api_key=api_key,
        model=model,
        prompt=prompt,
        schema=EXTRACT_JSON_SCHEMA,
        temperature=0.25,
        operation="extract",
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

    logger.info(
        "extract gemini success concepts=%s definitions=%s",
        len(payload.get("key_concepts") or []),
        len(payload.get("definitions") or []),
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
    operation: str = "gemini_json",
) -> dict[str, Any]:
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="GEMINI_API_KEY is not configured on the server.",
        )

    config = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=schema,
        temperature=temperature,
    )

    try:
        response = _generate_content_with_retry(
            api_key=api_key,
            model=model,
            contents=prompt,
            config=config,
            operation=operation,
        )
    except HTTPException:
        raise

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
