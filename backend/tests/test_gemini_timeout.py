import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

import gemini_service as gs
from gemini_service import (
    _gemini_client_for_attempt,
    _generate_content_with_retry,
)


def _mock_client_factory(client: MagicMock):
    def factory(_api_key: str, _timeout: float) -> MagicMock:
        return client

    return factory


class GeminiTimeoutTests(unittest.TestCase):

    def test_client_http_timeout_is_milliseconds(self) -> None:
        with patch("gemini_service.genai.Client") as mock_client_cls:
            _gemini_client_for_attempt("secret", 90.5)
        _, kwargs = mock_client_cls.call_args
        timeout_ms = kwargs["http_options"].timeout
        self.assertEqual(timeout_ms, 90500)

    @patch("gemini_service.time.sleep")
    def test_sdk_timeout_errors_retry_then_504(self, mock_sleep: MagicMock) -> None:
        client = MagicMock()
        timeout_exc = Exception("request timed out")

        client.models.generate_content.side_effect = [timeout_exc] * (
            gs.MAX_GEMINI_RETRIES + 1
        )

        with patch(
            "gemini_service._gemini_client_for_attempt",
            side_effect=_mock_client_factory(client),
        ):
            with self.assertRaises(HTTPException) as ctx:
                _generate_content_with_retry(
                    api_key="test-key",
                    model="gemini-test",
                    contents="hello",
                    config=MagicMock(),
                    operation="test",
                )

        self.assertEqual(ctx.exception.status_code, 504)
        self.assertEqual(
            client.models.generate_content.call_count,
            gs.MAX_GEMINI_RETRIES + 1,
        )

    @patch("gemini_service.time.sleep")
    def test_server_error_class_is_retryable(self, mock_sleep: MagicMock) -> None:
        client = MagicMock()
        ok_response = MagicMock()

        try:
            from google.genai import errors

            server_error = errors.ServerError("503", {"error": {"message": "busy"}})
        except Exception:
            server_error = Exception("503 UNAVAILABLE server")

        client.models.generate_content.side_effect = [server_error, ok_response]

        with patch(
            "gemini_service._gemini_client_for_attempt",
            side_effect=_mock_client_factory(client),
        ):
            result = _generate_content_with_retry(
                api_key="test-key",
                model="gemini-test",
                contents="hello",
                config=MagicMock(),
                operation="test",
            )

        self.assertIs(result, ok_response)
        self.assertEqual(client.models.generate_content.call_count, 2)

    @patch("gemini_service.time.monotonic")
    @patch("gemini_service.time.sleep")
    def test_wall_clock_exceeded_before_retry(
        self, mock_sleep: MagicMock, mock_monotonic: MagicMock
    ) -> None:
        client = MagicMock()
        transient = Exception("503 UNAVAILABLE")

        times = [0.0, 200.0]
        mock_monotonic.side_effect = lambda: times.pop(0) if times else 200.0

        client.models.generate_content.side_effect = [transient]

        with patch(
            "gemini_service._gemini_client_for_attempt",
            side_effect=_mock_client_factory(client),
        ):
            with patch.object(gs, "GEMINI_RETRY_MAX_WALL_SECONDS", 10.0):
                with self.assertRaises(HTTPException) as ctx:
                    _generate_content_with_retry(
                        api_key="test-key",
                        model="gemini-test",
                        contents="hello",
                        config=MagicMock(),
                        operation="test",
                    )

        self.assertEqual(ctx.exception.status_code, 504)

    @patch("gemini_service.time.sleep")
    def test_no_thread_pool_executor(self, mock_sleep: MagicMock) -> None:
        client = MagicMock()
        client.models.generate_content.return_value = MagicMock()

        with patch(
            "gemini_service._gemini_client_for_attempt",
            side_effect=_mock_client_factory(client),
        ):
            with patch("concurrent.futures.ThreadPoolExecutor") as mock_pool:
                _generate_content_with_retry(
                    api_key="test-key",
                    model="gemini-test",
                    contents="hello",
                    config=MagicMock(),
                    operation="test",
                )
                mock_pool.assert_not_called()


if __name__ == "__main__":
    unittest.main()