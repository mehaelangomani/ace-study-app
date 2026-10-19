import unittest
from unittest.mock import patch

from fastapi import HTTPException

from quiz_service import (
    _merge_valid_questions,
    _normalize_questions,
    _renumber_question_ids,
    generate_quiz_with_gemini,
)


def _mc_question(prompt: str, qid: str = "q1") -> dict:
    return {
        "id": qid,
        "type": "multiple_choice",
        "difficulty": "easy",
        "prompt": prompt,
        "source_concept": "Concept",
        "explanation": "Because the notes say so clearly.",
        "options": [
            {"id": "a", "text": "Alpha"},
            {"id": "b", "text": "Beta"},
            {"id": "c", "text": "Gamma"},
            {"id": "d", "text": "Delta"},
        ],
        "correct_option_ids": ["a"],
        "correct_answers": [],
    }


class QuizCountTests(unittest.TestCase):

    def test_normalize_dedupes_prompts(self) -> None:
        raw = [
            _mc_question("What is the first concept in these notes?"),
            _mc_question("What is the first concept in these notes?"),
        ]
        questions, stats = _normalize_questions(
            raw,
            allowed_types=["multiple_choice"],
            target_count=5,
        )
        self.assertEqual(len(questions), 1)
        self.assertEqual(stats["rejected_duplicate"], 1)

    def test_merge_respects_target_and_dedupes_against_existing(self) -> None:
        existing = [_mc_question("Question one about photosynthesis?")]
        duplicate = _mc_question("Question one about photosynthesis?")
        fresh = _mc_question("Question two about chlorophyll function?")

        merged = _merge_valid_questions(
            existing,
            [duplicate, fresh],
            target_count=2,
        )
        self.assertEqual(len(merged), 2)
        self.assertIn("chlorophyll", merged[1]["prompt"].lower())

    def test_renumber_question_ids(self) -> None:
        items = [
            dict(_mc_question("First valid quiz question here?"), id="x"),
            dict(_mc_question("Second valid quiz question here?"), id="y"),
        ]
        renumbered = _renumber_question_ids(items)
        self.assertEqual([q["id"] for q in renumbered], ["q1", "q2"])

    @patch("quiz_service._generate_json_with_gemini")
    def test_generate_tops_up_until_exact_count(self, mock_generate) -> None:
        batch_one = {
            "title": "Biology quiz",
            "questions": [
                _mc_question(f"Unique biology quiz question number {i}?")
                for i in range(1, 4)
            ],
        }
        batch_two = {
            "title": "Biology quiz",
            "questions": [
                _mc_question(f"Another biology quiz question number {i}?")
                for i in range(4, 6)
            ],
        }
        mock_generate.side_effect = [batch_one, batch_two]

        result = generate_quiz_with_gemini(
            api_key="test-key",
            model="test-model",
            notes="Photosynthesis converts light. Chlorophyll captures energy. "
            "Plants release oxygen. Glucose stores chemical energy.",
            title="Bio",
            question_count=5,
            difficulty="mixed",
            question_types=["multiple_choice"],
        )

        self.assertEqual(result["question_count"], 5)
        self.assertEqual(len(result["questions"]), 5)
        self.assertEqual(mock_generate.call_count, 2)
        self.assertEqual([q["id"] for q in result["questions"]], ["q1", "q2", "q3", "q4", "q5"])

    @patch("quiz_service._generate_json_with_gemini")
    def test_generate_fails_when_still_short(self, mock_generate) -> None:
        mock_generate.return_value = {
            "title": "Short quiz",
            "questions": [
                _mc_question("Only one valid question in this batch?"),
            ],
        }

        with self.assertRaises(HTTPException) as ctx:
            generate_quiz_with_gemini(
                api_key="test-key",
                model="test-model",
                notes="Mitochondria produce ATP. Ribosomes build proteins. "
                "DNA stores genetic information for the cell.",
                title="Cells",
                question_count=5,
                difficulty="easy",
                question_types=["multiple_choice"],
            )

        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("5", str(ctx.exception.detail))


if __name__ == "__main__":
    unittest.main()
