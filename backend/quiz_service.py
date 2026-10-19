import logging
import re
from typing import Any

import jwt
from fastapi import HTTPException, status

from gemini_service import _clean_str, _generate_json_with_gemini

logger = logging.getLogger("ace.quiz")

MAX_QUIZ_TOPUP_ATTEMPTS = 3

QUESTION_TYPES = frozenset(
    {"multiple_choice", "multiple_select", "true_false", "fill_blank"}
)
DIFFICULTIES = frozenset({"easy", "medium", "hard", "mixed"})

QUIZ_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "type": {"type": "string"},
                    "difficulty": {"type": "string"},
                    "prompt": {"type": "string"},
                    "source_concept": {"type": "string"},
                    "options": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "text": {"type": "string"},
                            },
                            "required": ["id", "text"],
                        },
                    },
                    "correct_option_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "correct_answers": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "explanation": {"type": "string"},
                },
                "required": ["id", "type", "difficulty", "prompt", "explanation"],
            },
        },
    },
    "required": ["title", "questions"],
}


def _normalize_difficulty(value: Any) -> str:
    raw = _clean_str(value).lower()
    if raw in DIFFICULTIES:
        return raw
    return "medium"


def _normalize_question_type(value: Any) -> str | None:
    raw = _clean_str(value).lower().replace(" ", "_").replace("-", "_")
    aliases = {
        "multiplechoice": "multiple_choice",
        "mcq": "multiple_choice",
        "multiple_select": "multiple_select",
        "multipleselect": "multiple_select",
        "true_false": "true_false",
        "truefalse": "true_false",
        "tf": "true_false",
        "fill_blank": "fill_blank",
        "fill_in_the_blank": "fill_blank",
        "fill_in_blank": "fill_blank",
    }
    if raw in aliases:
        raw = aliases[raw]
    if raw in QUESTION_TYPES:
        return raw
    return None


def _normalize_options(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    items: list[dict[str, str]] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            continue
        opt_id = _clean_str(entry.get("id")) or f"opt_{index + 1}"
        text = _clean_str(entry.get("text"))
        if len(text) < 1:
            continue
        items.append({"id": opt_id, "text": text})
    return items[:8]


def _prompt_fingerprint(prompt: str) -> str:
    return re.sub(r"\s+", " ", prompt.strip().lower())


def _empty_normalize_stats() -> dict[str, int]:
    return {
        "raw_seen": 0,
        "accepted": 0,
        "rejected_type": 0,
        "rejected_prompt": 0,
        "rejected_duplicate": 0,
        "rejected_explanation": 0,
        "rejected_options": 0,
        "rejected_answers": 0,
        "rejected_malformed": 0,
    }


def _try_normalize_question_entry(
    entry: dict[str, Any],
    *,
    allowed: set[str],
    seen_prompts: set[str],
) -> tuple[dict[str, Any] | None, str | None]:
    q_type = _normalize_question_type(entry.get("type"))
    if not q_type or q_type not in allowed:
        return None, "type"

    prompt = _clean_str(entry.get("prompt"))
    if len(prompt) < 8:
        return None, "prompt"

    prompt_key = _prompt_fingerprint(prompt)
    if prompt_key in seen_prompts:
        return None, "duplicate"

    explanation = _clean_str(entry.get("explanation"))
    if len(explanation) < 6:
        return None, "explanation"

    item: dict[str, Any] = {
        "id": _clean_str(entry.get("id")) or "pending",
        "type": q_type,
        "difficulty": _normalize_difficulty(entry.get("difficulty")),
        "prompt": prompt,
        "source_concept": _clean_str(entry.get("source_concept")) or None,
        "explanation": explanation,
        "options": [],
        "correct_option_ids": [],
        "correct_answers": [],
    }

    if q_type in ("multiple_choice", "multiple_select", "true_false"):
        options = _normalize_options(entry.get("options"))
        if q_type == "true_false" and len(options) < 2:
            options = [
                {"id": "true", "text": "True"},
                {"id": "false", "text": "False"},
            ]
        if len(options) < 2:
            return None, "options"

        correct_ids = [
            _clean_str(x)
            for x in (entry.get("correct_option_ids") or [])
            if _clean_str(x)
        ]
        if not correct_ids:
            return None, "options"

        valid_ids = {opt["id"] for opt in options}
        correct_ids = [cid for cid in correct_ids if cid in valid_ids]
        if not correct_ids:
            return None, "options"

        if q_type == "multiple_choice" and len(correct_ids) != 1:
            correct_ids = correct_ids[:1]
        if q_type == "true_false" and len(correct_ids) != 1:
            return None, "options"
        if q_type == "multiple_select" and len(correct_ids) < 2:
            return None, "options"

        item["options"] = options
        item["correct_option_ids"] = correct_ids

    elif q_type == "fill_blank":
        answers = [
            _clean_str(x)
            for x in (entry.get("correct_answers") or [])
            if _clean_str(x)
        ]
        if not answers:
            single = _clean_str(entry.get("correct_answer"))
            if single:
                answers = [single]
        if not answers:
            return None, "answers"
        item["correct_answers"] = answers[:6]

    seen_prompts.add(prompt_key)
    return item, None


def _normalize_questions(
    raw: Any,
    *,
    allowed_types: list[str],
    target_count: int,
    seen_prompts: set[str] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    stats = _empty_normalize_stats()

    if not isinstance(raw, list):
        return [], stats

    allowed = {t for t in allowed_types if t in QUESTION_TYPES}
    if not allowed:
        allowed = set(QUESTION_TYPES)

    normalized: list[dict[str, Any]] = []
    prompts = seen_prompts if seen_prompts is not None else set()

    for entry in raw:
        stats["raw_seen"] += 1

        if len(normalized) >= target_count:
            continue

        if not isinstance(entry, dict):
            stats["rejected_malformed"] += 1
            continue

        item, reason = _try_normalize_question_entry(
            entry,
            allowed=allowed,
            seen_prompts=prompts,
        )

        if item is None:
            if reason == "type":
                stats["rejected_type"] += 1
            elif reason == "prompt":
                stats["rejected_prompt"] += 1
            elif reason == "duplicate":
                stats["rejected_duplicate"] += 1
            elif reason == "explanation":
                stats["rejected_explanation"] += 1
            elif reason == "options":
                stats["rejected_options"] += 1
            elif reason == "answers":
                stats["rejected_answers"] += 1
            else:
                stats["rejected_malformed"] += 1
            continue

        normalized.append(item)
        stats["accepted"] += 1

    return normalized, stats


def _renumber_question_ids(questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    renumbered: list[dict[str, Any]] = []
    for index, question in enumerate(questions):
        item = dict(question)
        item["id"] = f"q{index + 1}"
        renumbered.append(item)
    return renumbered


def _merge_valid_questions(
    existing: list[dict[str, Any]],
    new_batch: list[dict[str, Any]],
    *,
    target_count: int,
) -> list[dict[str, Any]]:
    merged = existing[:]
    existing_fingerprints = {
        _prompt_fingerprint(question["prompt"]) for question in merged
    }

    for question in new_batch:
        if len(merged) >= target_count:
            break

        fingerprint = _prompt_fingerprint(question["prompt"])
        if fingerprint in existing_fingerprints:
            continue

        existing_fingerprints.add(fingerprint)
        merged.append(question)

    return merged[:target_count]


def _build_quiz_generation_prompt(
    *,
    notes: str,
    title: str | None,
    count: int,
    difficulty: str,
    type_list: str,
    existing_questions: list[dict[str, Any]],
    topup: bool,
) -> str:
    if not topup:
        return (
            "You are an expert educator creating a study quiz from student notes.\n\n"
            "STRICT RULES:\n"
            "- Use ONLY facts supported by the notes. Do not invent content.\n"
            f"- Return EXACTLY {count} questions in the questions array — no fewer.\n"
            f"- Allowed question types: {type_list}. Use only these types.\n"
            f"- Target difficulty: {difficulty} (use per-question difficulty when mixed).\n"
            "- multiple_choice: 4 plausible options, exactly one correct_option_ids entry.\n"
            "- multiple_select: 4-5 options, at least two correct_option_ids.\n"
            "- true_false: options with ids true and false.\n"
            "- fill_blank: no options; provide 1-3 acceptable correct_answers.\n"
            "- Each question needs prompt (8+ chars), explanation (6+ chars), source_concept.\n"
            "- All questions must be distinct. No duplicate prompts.\n"
            "- Return JSON only.\n\n"
            f"Quiz title hint: {title or '(derive from notes)'}\n\n"
            "STUDENT NOTES:\n"
            f"{notes}"
        )

    covered_lines = []
    for question in existing_questions[:24]:
        concept = question.get("source_concept") or question.get("prompt")
        if concept:
            covered_lines.append(f"- {concept}")

    covered_block = "\n".join(covered_lines) if covered_lines else "- (see prior batch)"

    return (
        "You are adding MORE questions to an in-progress study quiz from the same notes.\n\n"
        "STRICT RULES:\n"
        f"- Return EXACTLY {count} NEW questions in the questions array.\n"
        f"- Allowed question types: {type_list}.\n"
        f"- Target difficulty: {difficulty}.\n"
        "- Do NOT repeat or paraphrase any topic already covered below.\n"
        "- Use ONLY facts supported by the notes.\n"
        "- Return JSON only.\n\n"
        "ALREADY COVERED (do not repeat):\n"
        f"{covered_block}\n\n"
        f"Quiz title hint: {title or '(derive from notes)'}\n\n"
        "STUDENT NOTES:\n"
        f"{notes}"
    )


def strip_answers_for_client(questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    public: list[dict[str, Any]] = []
    for question in questions:
        public.append(
            {
                "id": question["id"],
                "type": question["type"],
                "difficulty": question["difficulty"],
                "prompt": question["prompt"],
                "source_concept": question.get("source_concept"),
                "options": question.get("options") or [],
            }
        )
    return public


def build_grading_payload(questions: list[dict[str, Any]]) -> dict[str, Any]:
    grading: dict[str, Any] = {}
    for question in questions:
        grading[question["id"]] = {
            "type": question["type"],
            "correct_option_ids": question.get("correct_option_ids") or [],
            "correct_answers": question.get("correct_answers") or [],
            "explanation": question.get("explanation") or "",
            "source_concept": question.get("source_concept"),
        }
    return grading


def seal_grading_payload(payload: dict[str, Any], secret: str) -> str:
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "Quiz grading is not configured on the server. "
                "Set QUIZ_GRADING_SECRET in backend/.env, or ensure "
                "GEMINI_API_KEY is set (used to derive a server-only grading key)."
            ),
        )
    return jwt.encode(
        {"v": 1, "grading": payload},
        secret,
        algorithm="HS256",
    )


def unseal_grading_payload(token: str, secret: str) -> dict[str, Any]:
    if not token or not secret:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid quiz grading token.",
        )
    try:
        decoded = jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Quiz grading token is invalid or expired.",
        )
    if not isinstance(decoded, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Quiz grading token payload is invalid.",
        )
    grading = decoded.get("grading")
    if not isinstance(grading, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Quiz grading data is missing.",
        )
    return grading


def _normalize_fill_answer(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def grade_single_answer(
    grading_entry: dict[str, Any],
    user_answer: Any,
) -> dict[str, Any]:
    q_type = grading_entry.get("type")
    correct = False
    user_display: Any = user_answer

    if q_type in ("multiple_choice", "true_false"):
        selected = _clean_str(user_answer) if user_answer is not None else ""
        correct_ids = grading_entry.get("correct_option_ids") or []
        correct = bool(selected and selected in correct_ids)
        user_display = selected

    elif q_type == "multiple_select":
        if isinstance(user_answer, list):
            selected = sorted({_clean_str(x) for x in user_answer if _clean_str(x)})
        else:
            selected = []
        correct_ids = sorted(grading_entry.get("correct_option_ids") or [])
        correct = selected == correct_ids
        user_display = selected

    elif q_type == "fill_blank":
        text = _clean_str(user_answer) if user_answer is not None else ""
        normalized = _normalize_fill_answer(text)
        acceptable = [
            _normalize_fill_answer(_clean_str(a))
            for a in (grading_entry.get("correct_answers") or [])
        ]
        correct = bool(normalized and normalized in acceptable)
        user_display = text

    return {
        "correct": correct,
        "user_answer": user_display,
        "correct_option_ids": grading_entry.get("correct_option_ids") or [],
        "correct_answers": grading_entry.get("correct_answers") or [],
        "explanation": grading_entry.get("explanation") or "",
        "source_concept": grading_entry.get("source_concept"),
    }


def grade_quiz_submission(
    grading: dict[str, Any],
    answers: dict[str, Any],
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    score = 0
    max_score = len(grading)

    weak_concepts: list[str] = []

    for question_id, grading_entry in grading.items():
        user_answer = answers.get(question_id)
        unanswered = user_answer is None or user_answer == "" or user_answer == []
        item = grade_single_answer(grading_entry, user_answer)
        item["question_id"] = question_id
        item["unanswered"] = unanswered
        if item["correct"]:
            score += 1
        elif not unanswered and grading_entry.get("source_concept"):
            weak_concepts.append(str(grading_entry["source_concept"]))
        results.append(item)

    accuracy = round((score / max_score) * 100, 1) if max_score else 0.0

    return {
        "score": score,
        "max_score": max_score,
        "accuracy": accuracy,
        "results": results,
        "weak_concepts": list(dict.fromkeys(weak_concepts))[:12],
    }


def generate_quiz_with_gemini(
    *,
    api_key: str,
    model: str,
    notes: str,
    title: str | None,
    question_count: int,
    difficulty: str,
    question_types: list[str],
) -> dict[str, Any]:
    allowed_types = [
        t
        for t in question_types
        if _normalize_question_type(t) in QUESTION_TYPES
    ]
    if not allowed_types:
        allowed_types = ["multiple_choice", "true_false"]

    difficulty = _normalize_difficulty(difficulty)
    count = int(question_count)
    if count not in (5, 10, 15, 20):
        count = max(5, min(20, count))

    type_list = ", ".join(allowed_types)
    seen_prompts: set[str] = set()
    collected: list[dict[str, Any]] = []
    quiz_title = _clean_str(title) or "Practice quiz"
    topup_attempts = 0

    logger.info(
        "quiz generation start requested_count=%s difficulty=%s types=%s",
        count,
        difficulty,
        type_list,
    )

    while len(collected) < count and topup_attempts <= MAX_QUIZ_TOPUP_ATTEMPTS:
        needed = count - len(collected)
        is_topup = topup_attempts > 0

        prompt = _build_quiz_generation_prompt(
            notes=notes,
            title=title,
            count=needed,
            difficulty=difficulty,
            type_list=type_list,
            existing_questions=collected,
            topup=is_topup,
        )

        parsed = _generate_json_with_gemini(
            api_key=api_key,
            model=model,
            prompt=prompt,
            schema=QUIZ_JSON_SCHEMA,
            temperature=0.32 if not is_topup else 0.38,
        )

        if not is_topup:
            quiz_title = (
                _clean_str(parsed.get("title")) or _clean_str(title) or "Practice quiz"
            )

        raw_questions = parsed.get("questions")
        batch, batch_stats = _normalize_questions(
            raw_questions,
            allowed_types=allowed_types,
            target_count=needed,
            seen_prompts=seen_prompts,
        )

        logger.info(
            "quiz generation batch attempt=%s raw=%s accepted=%s "
            "rejected_type=%s rejected_prompt=%s rejected_duplicate=%s "
            "rejected_explanation=%s rejected_options=%s rejected_answers=%s",
            topup_attempts,
            batch_stats["raw_seen"],
            batch_stats["accepted"],
            batch_stats["rejected_type"],
            batch_stats["rejected_prompt"],
            batch_stats["rejected_duplicate"],
            batch_stats["rejected_explanation"],
            batch_stats["rejected_options"],
            batch_stats["rejected_answers"],
        )

        collected = _merge_valid_questions(
            collected,
            batch,
            target_count=count,
        )

        logger.info(
            "quiz generation progress attempt=%s collected=%s target=%s",
            topup_attempts,
            len(collected),
            count,
        )

        if len(collected) >= count:
            break

        topup_attempts += 1

    if len(collected) < count:
        logger.warning(
            "quiz generation incomplete requested=%s available=%s topup_attempts=%s",
            count,
            len(collected),
            topup_attempts,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(
                f"Could only generate {len(collected)} of {count} valid questions "
                "from these notes. Try fewer questions or add more study content."
            ),
        )

    questions = _renumber_question_ids(collected[:count])

    logger.info(
        "quiz generation complete requested=%s final=%s topup_attempts=%s",
        count,
        len(questions),
        topup_attempts,
    )

    return {
        "title": quiz_title,
        "questions": questions,
        "question_count": count,
        "requested_count": count,
    }
