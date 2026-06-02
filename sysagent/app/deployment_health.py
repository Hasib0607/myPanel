from __future__ import annotations

_CURL_RETRY = [
    "--retry", "10",
    "--retry-delay", "3",
    "--retry-connrefused",
    "--connect-timeout", "5",
    "--max-time", "90",
]
_HTTP_CODE_MARKER = "\n__http_code="


def backend_only_laravel_health(process_name: str | None = None) -> dict:
    return {
        "dryRun": False,
        "command": ["backend-only-laravel-health", process_name or ""],
        "returncode": 0,
        "stdout": "Laravel deployment has no public/index.php; Supervisor process is running as backend-only/worker-safe idle process.",
        "stderr": "",
        "backendOnly": True,
    }


def _parse_http_probe(result: dict, url: str, *, accept_http_errors: bool) -> dict:
    stdout = result.get("stdout") or ""
    if _HTTP_CODE_MARKER in stdout:
        _, code_text = stdout.rsplit(_HTTP_CODE_MARKER, 1)
    else:
        code_text = stdout.strip()
    try:
        http_code = int(code_text.strip())
    except ValueError:
        http_code = 0

    result["httpCode"] = http_code
    result["stdout"] = code_text.strip()
    if result.get("returncode") != 0:
        return result

    if accept_http_errors and http_code >= 400:
        result["degraded"] = True
        result["stderr"] = (
            f"HTTP {http_code} from {url}. "
            "The process is responding, but the app returned an error status."
        )
        if http_code >= 500:
            result["stderr"] += (
                " Check APP_KEY, database connection env vars, and storage/bootstrap/cache permissions."
            )
    elif not accept_http_errors and http_code >= 400:
        result["returncode"] = 22
        result["stderr"] = f"HTTP {http_code} from {url}"
    return result


def _curl_http_probe(url: str, *, method: str, accept_http_errors: bool) -> dict:
    from app.command import run_command

    command = ["curl", "-sS", *_CURL_RETRY, "-X", method, "-w", f"{_HTTP_CODE_MARKER}%{{http_code}}", url]
    result = run_command(command, allow_live=True)
    return _parse_http_probe(result, url, accept_http_errors=accept_http_errors)


def curl_health_probe(url: str, *, accept_http_errors: bool = False) -> dict:
    from app.command import run_command

    if not accept_http_errors:
        return run_command(
            ["curl", "-fsS", *_CURL_RETRY, url],
            allow_live=True,
        )

    head = _curl_http_probe(url, method="HEAD", accept_http_errors=True)
    if head.get("returncode") == 0:
        return head

    get = _curl_http_probe(url, method="GET", accept_http_errors=True)
    if get.get("returncode") == 0:
        return get

    if head.get("returncode") not in {0, None}:
        head["stderr"] = head.get("stderr") or get.get("stderr") or "Health probe failed"
    return head if head.get("returncode") not in {0, None} else get
