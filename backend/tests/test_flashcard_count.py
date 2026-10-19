import unittest
from unittest.mock import patch

from fastapi import HTTPException

from flashcard_service import (
    _merge_valid_cards,
    _normalize_cards,
    generate_flashcards_with_gemini,
)


def _sample_card(front: str, card_id: str = "c1") -> dict:
    return {
        "id": card_id,
        "type": "definition",
        "front": front,
        "back": "A clear supported answer from the notes.",
        "difficulty": "easy",
        "source_concept": "Sample concept",
        "explanation": "Optional extra context for learning.",
    }


class FlashcardCountTests(unittest.TestCase):

    def test_normalize_dedupes_fronts(self) -> None:
        raw = [
            _sample_card("What is photosynthesis in plants?"),
            _sample_card("What is photosynthesis in plants?"),
        ]
        cards, stats = _normalize_cards(
            raw,
            allowed_types=["definition"],
            target_count=5,
        )
        self.assertEqual(len(cards), 1)
        self.assertEqual(stats["rejected_duplicate"], 1)

    def test_merge_appends_new_cards(self) -> None:
        existing = [_sample_card("First distinct flashcard front?")]
        fresh = [
            _sample_card("Second distinct flashcard front?"),
            _sample_card("Third distinct flashcard front?"),
        ]
        merged = _merge_valid_cards(existing, fresh, target_count=3)
        self.assertEqual(len(merged), 3)

    @patch("flashcard_service._generate_json_with_gemini")
    def test_generate_tops_up_until_exact_count(self, mock_generate) -> None:
        batch_one = {
            "title": "Bio deck",
            "cards": [
                _sample_card(f"Biology flashcard topic number {i}?")
                for i in range(1, 4)
            ],
        }
        batch_two = {
            "title": "Bio deck",
            "cards": [
                _sample_card(f"Another biology flashcard topic {i}?")
                for i in range(4, 6)
            ],
        }
        mock_generate.side_effect = [batch_one, batch_two]

        result = generate_flashcards_with_gemini(
            api_key="test-key",
            model="test-model",
            notes="Photosynthesis converts light. Chlorophyll captures energy. "
            "Plants release oxygen. Glucose stores chemical energy.",
            title="Bio",
            card_count=5,
            difficulty="mixed",
            card_types=["definition"],
        )

        self.assertEqual(result["card_count"], 5)
        self.assertEqual(len(result["cards"]), 5)
        self.assertEqual(mock_generate.call_count, 2)

    @patch("flashcard_service._generate_json_with_gemini")
    def test_generate_fails_when_still_short(self, mock_generate) -> None:
        mock_generate.return_value = {
            "title": "Short deck",
            "cards": [_sample_card("Only one valid flashcard front here?")],
        }

        with self.assertRaises(HTTPException) as ctx:
            generate_flashcards_with_gemini(
                api_key="test-key",
                model="test-model",
                notes="Mitochondria produce ATP. Ribosomes build proteins. "
                "DNA stores genetic information for the cell.",
                title="Cells",
                card_count=5,
                difficulty="easy",
                card_types=["definition"],
            )

        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("5", str(ctx.exception.detail))


if __name__ == "__main__":
    unittest.main()
