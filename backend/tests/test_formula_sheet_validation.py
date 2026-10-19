import unittest

from fastapi import HTTPException

from formula_sheet_service import (
    formula_sheet_has_formulas,
    generate_formula_sheet_with_gemini,
    normalize_formula_sheet_payload,
)


class FormulaSheetValidationTests(unittest.TestCase):

    def test_normalize_dedupes_expressions(self) -> None:
        parsed = {
            "title": "Physics",
            "categories": [
                {
                    "name": "Motion",
                    "formulas": [
                        {
                            "name": "Velocity",
                            "expression": "v = d/t",
                            "description": "Speed equals distance divided by time.",
                            "variables": [{"symbol": "v", "meaning": "velocity"}],
                        },
                        {
                            "name": "Velocity duplicate",
                            "expression": "v = d / t",
                            "description": "Duplicate expression should be removed.",
                            "variables": [{"symbol": "v", "meaning": "velocity"}],
                        },
                    ],
                }
            ],
            "quick_reference": [],
        }
        result = normalize_formula_sheet_payload(parsed, title="Physics")
        self.assertEqual(result["formula_count"], 1)

    def test_empty_sheet_has_no_formulas(self) -> None:
        result = normalize_formula_sheet_payload(
            {"title": "Empty", "categories": [], "quick_reference": []},
            title="Empty",
        )
        self.assertFalse(formula_sheet_has_formulas(result))

    def test_generate_raises_when_no_formulas(self) -> None:
        from unittest.mock import patch

        with patch("formula_sheet_service._generate_json_with_gemini") as mock_gen:
            mock_gen.return_value = {
                "title": "Empty",
                "categories": [],
                "quick_reference": [],
            }
            with self.assertRaises(HTTPException) as ctx:
                generate_formula_sheet_with_gemini(
                    api_key="k",
                    model="m",
                    notes="This paragraph has no equations at all, only prose.",
                    title="Notes",
                )
            self.assertEqual(ctx.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
