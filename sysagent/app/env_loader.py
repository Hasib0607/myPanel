import os
from pathlib import Path


def panel_env_path() -> Path | None:
    candidates = (
        Path(__file__).resolve().parent.parent.parent / ".env",
        Path(__file__).resolve().parent.parent / ".env",
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def reload_panel_env() -> Path | None:
    path = panel_env_path()
    if path is None:
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        key = key.strip()
        if not key:
            continue
        os.environ[key] = value.strip().strip('"').strip("'")
    return path
