import hashlib
import os
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()


def resolve_quiz_grading_secret(
    *,
    explicit: str,
    jwt_secret: str,
    gemini_api_key: str,
    supabase_url: str,
) -> str:
    """
    Secret used only on the server to sign quiz grading payloads (HS256).
    Never sent to the browser except as opaque grading_token values.
    """

    if explicit:
        return explicit

    if jwt_secret:
        return jwt_secret

    gemini = (gemini_api_key or "").strip()
    if gemini:
        material = (
            "ace-quiz-grading:v1|"
            + (supabase_url or "").strip()
            + "|"
            + gemini
        )
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    return ""


@lru_cache
def get_settings() -> dict[str, str | list[str]]:
    cors_raw = os.getenv(
        "CORS_ORIGINS",
        "http://127.0.0.1:5502,http://localhost:5502,"
        "http://127.0.0.1:5500,http://localhost:5500",
    )
    cors_origins = [
        origin.strip()
        for origin in cors_raw.split(",")
        if origin.strip()
    ]

    supabase_url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")

    jwt_secret = os.getenv("SUPABASE_JWT_SECRET", "").strip()
    gemini_api_key = os.getenv("GEMINI_API_KEY", "").strip()
    quiz_grading_explicit = os.getenv("QUIZ_GRADING_SECRET", "").strip()
    quiz_grading_secret = resolve_quiz_grading_secret(
        explicit=quiz_grading_explicit,
        jwt_secret=jwt_secret,
        gemini_api_key=gemini_api_key,
        supabase_url=supabase_url,
    )

    return {
        "gemini_api_key": gemini_api_key,
        "gemini_model": os.getenv("GEMINI_MODEL", "gemini-2.0-flash").strip(),
        "supabase_url": supabase_url,
        "supabase_jwt_secret": jwt_secret,
        "quiz_grading_secret": quiz_grading_secret,
        "cors_origins": cors_origins,
    }
