import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

from gemini_service import (
    MAX_GEMINI_RETRIES,
    _generate_content_with_retry,
    _is_gemini_non_retryable,
    _is_gemini_retryable,
)


class GeminiRetryTests(unittest.TestCase):

    def test_unavailable_is_retryable(self) -> None:
        message = "503 UNAVAILABLE. The model is overloaded."
        lowered = message.lower()
        self.assertTrue(_is_gemini_retryable(message, lowered))
        self.assertFalse(_is_gemini_non_retryable(message, lowered))

    def test_invalid_api_key_not_retryable(self) -> None:
        message = "400 INVALID_ARGUMENT. API key not valid."
        lowered = message.lower()
        self.assertTrue(_is_gemini_non_retryable(message, lowered))
        self.assertFalse(_is_gemini_retryable(message, lowered))

    @patch("gemini_service.time.sleep")
    def test_retries_then_succeeds(self, mock_sleep: MagicMock) -> None:
        client = MagicMock()
        ok_response = MagicMock()
        transient = Exception("503 UNAVAILABLE due to high demand")

        client.models.generate_content.side_effect = [
            transient,
            transient,
            ok_response,
        ]

        with patch(
            "gemini_service._gemini_client_for_attempt",
            return_value=client,
        ):
            result = _generate_content_with_retry(
                api_key="test-key",
                model="gemini-test",
                contents="hello",
                config=MagicMock(),
            )

        self.assertIs(result, ok_response)
        self.assertEqual(client.models.generate_content.call_count, 3)
        self.assertEqual(mock_sleep.call_count, 2)

    @patch("gemini_service.time.sleep")
    def test_exhausted_retries_raise_503(self, mock_sleep: MagicMock) -> None:
        client = MagicMock()
        transient = Exception("503 UNAVAILABLE")

        client.models.generate_content.side_effect = [transient] * (
            MAX_GEMINI_RETRIES + 1
        )

        with patch(
            "gemini_service._gemini_client_for_attempt",
            return_value=client,
        ):
            with self.assertRaises(HTTPException) as ctx:
                _generate_content_with_retry(
                    api_key="test-key",
                    model="gemini-test",
                    contents="hello",
                    config=MagicMock(),
                )

        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(
            client.models.generate_content.call_count,
            MAX_GEMINI_RETRIES + 1,
        )


if __name__ == "__main__":
    unittest.main()