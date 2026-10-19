import unittest

from gemini_service import (
    _normalize_concepts,
    _normalize_definitions,
    _normalize_key_concepts,
    cheatsheet_has_content,
    derive_flat_concepts,
    extraction_has_content,
    normalize_cheatsheet_payload,
    normalize_extraction_payload,
)


class GeminiValidationTests(unittest.TestCase):

    def test_normalize_concepts_filters_empty(self) -> None:
        result = _normalize_concepts(["  alpha  ", "", "x", "valid concept"])
        self.assertEqual(result, ["alpha", "valid concept"])

    def test_normalize_concepts_rejects_non_list(self) -> None:
        self.assertEqual(_normalize_concepts(None), [])
        self.assertEqual(_normalize_concepts("text"), [])

    def test_normalize_key_concepts_requires_explanation(self) -> None:
        result = _normalize_key_concepts(
            [
                {"title": "Photosynthesis", "explanation": "Process plants use to convert light to energy."},
                {"title": "Too short", "explanation": "tiny"},
            ]
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["title"], "Photosynthesis")

    def test_normalize_definitions(self) -> None:
        result = _normalize_definitions(
            [{"term": "Mitochondria", "definition": "Organelle that produces ATP for the cell."}]
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["term"], "Mitochondria")

    def test_derive_flat_concepts(self) -> None:
        payload = {
            "key_concepts": [{"title": "Gravity", "explanation": "Force of attraction between masses."}],
            "definitions": [{"term": "Mass", "definition": "Measure of matter in an object."}],
            "formulas": [{"formula": "F=ma", "meaning": "Newton's second law."}],
            "key_takeaways": ["Force equals mass times acceleration."],
        }
        concepts = derive_flat_concepts(payload)
        self.assertIn("Gravity", concepts)
        self.assertIn("Mass", concepts)
        self.assertIn("F=ma", concepts)

    def test_extraction_has_content(self) -> None:
        self.assertFalse(extraction_has_content({"key_concepts": [], "definitions": [], "formulas": [], "key_takeaways": []}))
        self.assertTrue(
            extraction_has_content(
                {
                    "key_concepts": [{"title": "A", "explanation": "Long enough explanation here."}],
                    "definitions": [],
                    "formulas": [],
                    "key_takeaways": [],
                }
            )
        )

    def test_normalize_extraction_payload(self) -> None:
        parsed = {
            "title": "Biology basics",
            "key_concepts": [
                {
                    "title": "Cell",
                    "explanation": "The basic structural unit of living organisms.",
                    "example": "A red blood cell carries oxygen.",
                }
            ],
            "definitions": [],
            "formulas": [],
            "key_takeaways": ["Cells are the building blocks of life."],
        }
        result = normalize_extraction_payload(parsed, title=None, subject=None, difficulty=None)
        self.assertEqual(result["title"], "Biology basics")
        self.assertTrue(result["concepts"])

    def test_normalize_cheatsheet_payload(self) -> None:
        parsed = {
            "title": "Physics revision",
            "subject": "Physics",
            "overview": "Core mechanics ideas from the lecture notes.",
            "key_concepts": [
                {
                    "title": "Velocity",
                    "definition": "Rate of change of displacement with respect to time.",
                    "explanation": "Velocity tells you how fast position changes and in which direction.",
                }
            ],
            "important_definitions": [
                {
                    "term": "Acceleration",
                    "definition": "Rate of change of velocity over time.",
                }
            ],
            "formulas": [
                {
                    "name": "Newton's second law",
                    "expression": "F = ma",
                    "variables": [{"symbol": "F", "meaning": "Net force"}],
                }
            ],
            "key_points": ["Force causes acceleration."],
            "examples": [],
            "quick_revision": ["F = ma"],
        }
        result = normalize_cheatsheet_payload(
            parsed,
            title=None,
            subject=None,
        )
        self.assertEqual(result["title"], "Physics revision")
        self.assertTrue(cheatsheet_has_content(result))


if __name__ == "__main__":
    unittest.main()
