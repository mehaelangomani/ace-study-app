import unittest

from config import resolve_quiz_grading_secret
from quiz_service import build_grading_payload, seal_grading_payload, unseal_grading_payload


class QuizGradingConfigTests(unittest.TestCase):

    def test_explicit_secret_takes_priority(self) -> None:
        secret = resolve_quiz_grading_secret(
            explicit="custom-secret",
            jwt_secret="jwt",
            gemini_api_key="gemini",
            supabase_url="https://example.supabase.co",
        )
        self.assertEqual(secret, "custom-secret")

    def test_jwt_secret_fallback(self) -> None:
        secret = resolve_quiz_grading_secret(
            explicit="",
            jwt_secret="jwt-only",
            gemini_api_key="gemini",
            supabase_url="https://example.supabase.co",
        )
        self.assertEqual(secret, "jwt-only")

    def test_derives_from_gemini_when_no_jwt_secret(self) -> None:
        secret = resolve_quiz_grading_secret(
            explicit="",
            jwt_secret="",
            gemini_api_key="test-gemini-key",
            supabase_url="https://example.supabase.co",
        )
        self.assertTrue(len(secret) == 64)

        again = resolve_quiz_grading_secret(
            explicit="",
            jwt_secret="",
            gemini_api_key="test-gemini-key",
            supabase_url="https://example.supabase.co",
        )
        self.assertEqual(secret, again)

    def test_seal_and_unseal_round_trip(self) -> None:
        secret = resolve_quiz_grading_secret(
            explicit="",
            jwt_secret="",
            gemini_api_key="round-trip-key",
            supabase_url="https://project.supabase.co",
        )
        grading = build_grading_payload(
            [
                {
                    "id": "q1",
                    "type": "true_false",
                    "difficulty": "easy",
                    "prompt": "Sample?",
                    "options": [
                        {"id": "true", "text": "True"},
                        {"id": "false", "text": "False"},
                    ],
                    "correct_option_ids": ["true"],
                    "correct_answers": [],
                    "explanation": "Because notes say so.",
                }
            ]
        )
        token = seal_grading_payload(grading, secret)
        restored = unseal_grading_payload(token, secret)
        self.assertEqual(restored["q1"]["correct_option_ids"], ["true"])


if __name__ == "__main__":
    unittest.main()
