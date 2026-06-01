from __future__ import annotations
from app.platform import current_os, service_spec

SERVICE_METADATA = {
    "nginx": {"name": "Nginx", "port": 80},
    "bind9": {"name": "BIND9", "port": 53},
    "postfix": {"name": "Postfix", "port": 25},
    "dovecot": {"name": "Dovecot", "port": 993},
}


def service_checks() -> dict[str, dict]:
    info = current_os()
    checks: dict[str, dict] = {}
    for key, meta in SERVICE_METADATA.items():
        spec = service_spec(key, info)
        checks[key] = {
            **meta,
            "unit": spec.unit,
            "units": list(spec.units),
            "packages": list(spec.packages),
        }
    return checks
