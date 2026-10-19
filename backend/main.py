from typing import Annotated, Any

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from pydantic import BaseModel, Field, field_validator

from auth import verify_supabase_access_token
from config import get_settings
from gemini_service import extract_concepts_with_gemini, generate_cheatsheet_with_gemini
from flashcard_service import generate_flashcards_with_gemini
from formula_sheet_service import generate_formula_sheet_with_gemini
from quiz_service import (
    build_grading_payload,
    generate_quiz_with_gemini,
    grade_quiz_submission,
    grade_single_answer,
    seal_grading_payload,
    strip_answers_for_client,
    unseal_grading_payload,
)

app = FastAPI(title="Ace API", version="1.0.0")

settings = get_settings()

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings["cors_origins"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

bearer_scheme = HTTPBearer(auto_error=False)


class ExtractRequest(BaseModel):
    notes: str = Field(..., min_length=1)
    title: str | None = None
    subject: str | None = None
    difficulty: str | None = None

    @field_validator("notes")
    @classmethod
    def notes_not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Notes cannot be empty.")
        if len(stripped) < 10:
            raise ValueError("Notes are too short to extract meaningful concepts.")
        return stripped

    @field_validator("title", "subject", "difficulty")
    @classmethod
    def optional_trim(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        return trimmed or None


class KeyConceptOut(BaseModel):
    title: str
    explanation: str
    example: str | None = None


class DefinitionOut(BaseModel):
    term: str
    definition: str


class FormulaOut(BaseModel):
    formula: str
    meaning: str
    variables: str | None = None
    example: str | None = None


class CheatsheetVariableOut(BaseModel):
    symbol: str
    meaning: str


class CheatsheetFormulaOut(BaseModel):
    name: str
    expression: str
    variables: list[CheatsheetVariableOut] = Field(default_factory=list)
    example: str | None = None


class CheatsheetConceptOut(BaseModel):
    title: str
    definition: str
    explanation: str
    example: str | None = None


class CheatsheetDefinitionOut(BaseModel):
    term: str
    definition: str


class CheatsheetExampleOut(BaseModel):
    title: str
    explanation: str


class CheatsheetResponse(BaseModel):
    title: str
    subject: str | None = None
    overview: str
    key_concepts: list[CheatsheetConceptOut]
    important_definitions: list[CheatsheetDefinitionOut]
    formulas: list[CheatsheetFormulaOut]
    key_points: list[str]
    examples: list[CheatsheetExampleOut] = Field(default_factory=list)
    quick_revision: list[str]


class CheatsheetRequest(BaseModel):
    notes: str = Field(..., min_length=1)
    title: str | None = None
    subject: str | None = None

    @field_validator("notes")
    @classmethod
    def notes_not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Notes cannot be empty.")
        if len(stripped) < 10:
            raise ValueError("Notes are too short to generate a cheatsheet.")
        return stripped

    @field_validator("title", "subject")
    @classmethod
    def optional_trim_cheatsheet(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        return trimmed or None


class ExtractResponse(BaseModel):
    title: str
    key_concepts: list[KeyConceptOut]
    definitions: list[DefinitionOut]
    formulas: list[FormulaOut]
    key_takeaways: list[str]
    concepts: list[str]
    source_text: str
    subject: str | None = None
    difficulty: str | None = None


def get_current_user(
    credentials: Annotated[
        HTTPAuthorizationCredentials | None,
        Depends(bearer_scheme),
    ],
) -> dict:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header must be: Bearer <access_token>",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return verify_supabase_access_token(
        credentials.credentials,
        settings,
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/extract", response_model=ExtractResponse)
def api_extract(
    body: ExtractRequest,
    _user: Annotated[dict, Depends(get_current_user)],
) -> ExtractResponse:
    _ = _user["user_id"]

    ai_result = extract_concepts_with_gemini(
        api_key=settings["gemini_api_key"],
        model=settings["gemini_model"],
        notes=body.notes,
        title=body.title,
        subject=body.subject,
        difficulty=body.difficulty,
    )

    return ExtractResponse(
        title=ai_result["title"],
        key_concepts=ai_result["key_concepts"],
        definitions=ai_result["definitions"],
        formulas=ai_result["formulas"],
        key_takeaways=ai_result["key_takeaways"],
        concepts=ai_result["concepts"],
        source_text=body.notes,
        subject=ai_result.get("subject"),
        difficulty=ai_result.get("difficulty"),
    )


class GenerateQuizRequest(BaseModel):
    notes: str = Field(..., min_length=1)
    title: str | None = None
    question_count: int = Field(default=10, ge=5, le=20)
    difficulty: str = Field(default="mixed")
    question_types: list[str] = Field(default_factory=list)

    @field_validator("notes")
    @classmethod
    def notes_not_blank_quiz(cls, value: str) -> str:
        stripped = value.strip()
        if len(stripped) < 10:
            raise ValueError("Notes are too short to generate a quiz.")
        return stripped

    @field_validator("title")
    @classmethod
    def optional_trim_quiz_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        return trimmed or None

    @field_validator("question_count")
    @classmethod
    def normalize_question_count(cls, value: int) -> int:
        if value in (5, 10, 15, 20):
            return value
        if value <= 7:
            return 5
        if value <= 12:
            return 10
        if value <= 17:
            return 15
        return 20


class QuizQuestionPublicOut(BaseModel):
    id: str
    type: str
    difficulty: str
    prompt: str
    source_concept: str | None = None
    options: list[dict[str, str]] = Field(default_factory=list)


class GenerateQuizResponse(BaseModel):
    title: str
    question_count: int
    questions: list[QuizQuestionPublicOut]
    grading_token: str
    settings_echo: dict[str, Any]


class QuizGradeRequest(BaseModel):
    grading_token: str = Field(..., min_length=10)
    answers: dict[str, Any] = Field(default_factory=dict)


class QuizCheckAnswerRequest(BaseModel):
    grading_token: str = Field(..., min_length=10)
    question_id: str = Field(..., min_length=1)
    answer: Any = None


@app.post("/api/generate-quiz", response_model=GenerateQuizResponse)
def api_generate_quiz(
    body: GenerateQuizRequest,
    _user: Annotated[dict, Depends(get_current_user)],
) -> GenerateQuizResponse:
    _ = _user["user_id"]

    ai_result = generate_quiz_with_gemini(
        api_key=settings["gemini_api_key"],
        model=settings["gemini_model"],
        notes=body.notes,
        title=body.title,
        question_count=body.question_count,
        difficulty=body.difficulty,
        question_types=body.question_types,
    )

    grading = build_grading_payload(ai_result["questions"])
    grading_secret = str(settings.get("quiz_grading_secret") or "")
    grading_token = seal_grading_payload(grading, grading_secret)

    public_questions = strip_answers_for_client(ai_result["questions"])

    return GenerateQuizResponse(
        title=ai_result["title"],
        question_count=ai_result["question_count"],
        questions=public_questions,
        grading_token=grading_token,
        settings_echo={
            "question_count": body.question_count,
            "difficulty": body.difficulty,
            "question_types": body.question_types,
        },
    )


@app.post("/api/quiz/grade")
def api_quiz_grade(
    body: QuizGradeRequest,
    _user: Annotated[dict, Depends(get_current_user)],
) -> dict[str, Any]:
    _ = _user["user_id"]

    grading_secret = str(settings.get("quiz_grading_secret") or "")
    grading = unseal_grading_payload(body.grading_token, grading_secret)

    return grade_quiz_submission(grading, body.answers)


@app.post("/api/quiz/check-answer")
def api_quiz_check_answer(
    body: QuizCheckAnswerRequest,
    _user: Annotated[dict, Depends(get_current_user)],
) -> dict[str, Any]:
    _ = _user["user_id"]

    grading_secret = str(settings.get("quiz_grading_secret") or "")
    grading = unseal_grading_payload(body.grading_token, grading_secret)

    entry = grading.get(body.question_id)
    if not entry:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Question not found in this quiz.",
        )

    result = grade_single_answer(entry, body.answer)
    return {
        "question_id": body.question_id,
        "correct": result["correct"],
        "explanation": result["explanation"],
        "correct_option_ids": result["correct_option_ids"],
        "correct_answers": result["correct_answers"],
    }


class GenerateFlashcardsRequest(BaseModel):
    notes: str = Field(..., min_length=1)
    title: str | None = None
    study_set_id: str | None = None
    card_count: int = Field(default=10, ge=5, le=30)
    difficulty: str = Field(default="mixed")
    card_types: list[str] = Field(default_factory=list)
    shuffle: bool = Field(default=True)

    @field_validator("notes")
    @classmethod
    def notes_not_blank_flashcards(cls, value: str) -> str:
        stripped = value.strip()
        if len(stripped) < 10:
            raise ValueError("Notes are too short to generate flashcards.")
        return stripped

    @field_validator("title")
    @classmethod
    def optional_trim_flashcards_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        return trimmed or None

    @field_validator("card_count")
    @classmethod
    def normalize_card_count(cls, value: int) -> int:
        if value in (5, 10, 15, 20, 30):
            return value
        if value <= 7:
            return 5
        if value <= 12:
            return 10
        if value <= 17:
            return 15
        if value <= 25:
            return 20
        return 30


class FlashcardOut(BaseModel):
    id: str
    type: str
    front: str
    back: str
    explanation: str | None = None
    difficulty: str
    source_concept: str | None = None


class GenerateFlashcardsResponse(BaseModel):
    title: str
    card_count: int
    cards: list[FlashcardOut]
    settings_echo: dict[str, Any]


@app.post("/api/generate-flashcards", response_model=GenerateFlashcardsResponse)
def api_generate_flashcards(
    body: GenerateFlashcardsRequest,
    _user: Annotated[dict, Depends(get_current_user)],
) -> GenerateFlashcardsResponse:
    _ = _user["user_id"]

    ai_result = generate_flashcards_with_gemini(
        api_key=settings["gemini_api_key"],
        model=settings["gemini_model"],
        notes=body.notes,
        title=body.title,
        card_count=body.card_count,
        difficulty=body.difficulty,
        card_types=body.card_types,
    )

    return GenerateFlashcardsResponse(
        title=ai_result["title"],
        card_count=ai_result["card_count"],
        cards=ai_result["cards"],
        settings_echo={
            "card_count": body.card_count,
            "difficulty": body.difficulty,
            "card_types": body.card_types,
            "shuffle": body.shuffle,
            "study_set_id": body.study_set_id,
        },
    )


class GenerateFormulaSheetRequest(BaseModel):
    notes: str = Field(..., min_length=1)
    title: str | None = None
    subject: str | None = None
    study_set_id: str | None = None

    @field_validator("notes")
    @classmethod
    def notes_not_blank_formula_sheet(cls, value: str) -> str:
        stripped = value.strip()
        if len(stripped) < 10:
            raise ValueError("Notes are too short to generate a formula sheet.")
        return stripped

    @field_validator("title", "subject")
    @classmethod
    def optional_trim_formula_fields(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        return trimmed or None


class FormulaVariableOut(BaseModel):
    symbol: str
    meaning: str
    unit: str | None = None


class FormulaExampleOut(BaseModel):
    problem: str | None = None
    steps: list[str] = Field(default_factory=list)
    answer: str | None = None


class FormulaItemOut(BaseModel):
    id: str
    name: str
    expression: str
    description: str
    variables: list[FormulaVariableOut] = Field(default_factory=list)
    conditions: str | None = None
    example: FormulaExampleOut | None = None
    source_concept: str | None = None


class FormulaCategoryOut(BaseModel):
    name: str
    formulas: list[FormulaItemOut]


class QuickReferenceOut(BaseModel):
    name: str
    expression: str
    usage: str = ""


class GenerateFormulaSheetResponse(BaseModel):
    title: str
    subject: str | None = None
    overview: str = ""
    formula_count: int
    categories: list[FormulaCategoryOut]
    quick_reference: list[QuickReferenceOut] = Field(default_factory=list)
    settings_echo: dict[str, Any] = Field(default_factory=dict)


@app.post("/api/generate-formula-sheet", response_model=GenerateFormulaSheetResponse)
def api_generate_formula_sheet(
    body: GenerateFormulaSheetRequest,
    _user: Annotated[dict, Depends(get_current_user)],
) -> GenerateFormulaSheetResponse:
    _ = _user["user_id"]

    ai_result = generate_formula_sheet_with_gemini(
        api_key=settings["gemini_api_key"],
        model=settings["gemini_model"],
        notes=body.notes,
        title=body.title,
        subject=body.subject,
    )

    return GenerateFormulaSheetResponse(
        title=ai_result["title"],
        subject=ai_result.get("subject"),
        overview=ai_result.get("overview") or "",
        formula_count=int(ai_result.get("formula_count") or 0),
        categories=ai_result.get("categories") or [],
        quick_reference=ai_result.get("quick_reference") or [],
        settings_echo={"study_set_id": body.study_set_id},
    )


@app.post("/api/generate-cheatsheet", response_model=CheatsheetResponse)
def api_generate_cheatsheet(
    body: CheatsheetRequest,
    _user: Annotated[dict, Depends(get_current_user)],
) -> CheatsheetResponse:
    _ = _user["user_id"]

    ai_result = generate_cheatsheet_with_gemini(
        api_key=settings["gemini_api_key"],
        model=settings["gemini_model"],
        notes=body.notes,
        title=body.title,
        subject=body.subject,
    )

    return CheatsheetResponse(**ai_result)


@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "Ace API",
        "health": "/health",
        "extract": "POST /api/extract",
        "generate_cheatsheet": "POST /api/generate-cheatsheet",
        "generate_quiz": "POST /api/generate-quiz",
        "generate_flashcards": "POST /api/generate-flashcards",
        "generate_formula_sheet": "POST /api/generate-formula-sheet",
        "quiz_grade": "POST /api/quiz/grade",
    }
