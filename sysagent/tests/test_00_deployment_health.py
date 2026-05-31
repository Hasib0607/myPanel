import unittest

from app.deployment_health import _parse_http_probe


class DeploymentHealthTests(unittest.TestCase):
    def test_parse_http_probe_marks_laravel_500_as_degraded(self) -> None:
        result = _parse_http_probe(
            {"returncode": 0, "stdout": "500\n__http_code=500", "stderr": ""},
            "http://127.0.0.1:10003/",
            accept_http_errors=True,
        )
        self.assertTrue(result["degraded"])
        self.assertEqual(result["httpCode"], 500)

    def test_parse_http_probe_keeps_strict_http_errors_as_failures(self) -> None:
        result = _parse_http_probe(
            {"returncode": 0, "stdout": "500\n__http_code=500", "stderr": ""},
            "http://127.0.0.1:10003/",
            accept_http_errors=False,
        )
        self.assertEqual(result["returncode"], 22)


if __name__ == "__main__":
    unittest.main()
