import unittest

from auth import auth_configuration_error


class AuthConfigTests(unittest.TestCase):

    def test_missing_both_url_and_secret(self) -> None:
        message = auth_configuration_error(
            {"supabase_url": "", "supabase_jwt_secret": ""}
        )
        self.assertIsNotNone(message)
        self.assertIn("SUPABASE_URL", message)

    def test_url_only_is_valid(self) -> None:
        message = auth_configuration_error(
            {
                "supabase_url": "https://example.supabase.co",
                "supabase_jwt_secret": "",
            }
        )
        self.assertIsNone(message)


if __name__ == "__main__":
    unittest.main()
