import unittest

from quiz_service import (
    build_grading_payload,
    grade_quiz_submission,
    grade_single_answer,
    strip_answers_for_client,
)


class QuizValidationTests(unittest.TestCase):

    def test_strip_answers_for_client(self) -> None:
        questions = [
            {
                "id": "q1",
                "type": "multiple_choice",
                "difficulty": "easy",
                "prompt": "What is photosynthesis?",
                "source_concept": "Photosynthesis",
                "options": [{"id": "a", "text": "Light to energy"}],
                "correct_option_ids": ["a"],
                "correct_answers": [],
                "explanation": "Plants convert light into chemical energy.",
            }
        ]
        public = strip_answers_for_client(questions)
        self.assertNotIn("correct_option_ids", public[0])
        self.assertNotIn("explanation", public[0])

    def test_grade_fill_blank_normalizes_whitespace(self) -> None:
        entry = {
            "type": "fill_blank",
            "correct_answers": ["Mitochondria"],
            "correct_option_ids": [],
            "explanation": "Powerhouse of the cell.",
        }
        result = grade_single_answer(entry, "  mitochondria  ")
        self.assertTrue(result["correct"])

    def test_grade_quiz_submission(self) -> None:
        grading = build_grading_payload(
            [
                {
                    "id": "q1",
                    "type": "true_false",
                    "difficulty": "easy",
                    "prompt": "Water boils at 100C at sea level.",
                    "options": [
                        {"id": "true", "text": "True"},
                        {"id": "false", "text": "False"},
                    ],
                    "correct_option_ids": ["true"],
                    "correct_answers": [],
                    "explanation": "Standard atmospheric pressure.",
                    "source_concept": "Boiling point",
                }
            ]
        )
        outcome = grade_quiz_submission(grading, {"q1": "true"})
        self.assertEqual(outcome["score"], 1)
        self.assertEqual(outcome["max_score"], 1)


if __name__ == "__main__":
    unittest.main()
