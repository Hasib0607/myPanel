"""OS detection and platform-specific constants for sysagent.

Phase 0 foundation only — routers still use hardcoded Ubuntu paths/commands until
Phase 1 wires this module in.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import os
from pathlib import Path
from typing import Literal

OsFamilyName = Literal["debian", "rhel", "unknown"]
PackageManagerName = Literal["apt", "dnf"]
FirewallBackendName = Literal["ufw", "firewalld"]
InstallFailureMode = Literal["abort", "continue"]

OS_RELEASE_PATH = Path("/etc/os-release")

# No known code gaps remain for AlmaLinux. Live VPS QA is tracked in docs.
INCOMPLETE_ON_ALMA: frozenset[str] = frozenset()

DEBIAN_IDS = frozenset({"debian", "ubuntu"})
RHEL_IDS = frozenset({"almalinux", "rocky", "rhel", "centos", "centos_stream", "fedora"})

# AlmaLinux 9 / RHEL 9: certbot and composer are distributed via EPEL (CRB should be enabled first).
EPEL_PACKAGE = "epel-release"
CRB_ENABLE_COMMAND = ("dnf", "config-manager", "--set-enabled", "crb")
EPEL_INSTALL_COMMAND = ("dnf", "install", "-y", EPEL_PACKAGE)

RHEL_CERTBOT_PACKAGES = ("certbot", "python3-certbot-nginx")
RHEL_COMPOSER_PACKAGES = ("composer", "php-cli")
DEBIAN_DOVECOT_PACKAGES = ("dovecot-core", "dovecot-imapd", "dovecot-lmtpd")
RHEL_DOVECOT_PACKAGES = ("dovecot",)
DOVECOT_RHEL_NOTES = (
    "AlmaLinux/RHEL 9 ships a single dovecot package that includes IMAP, POP3, and LMTP. "
    "Debian/Ubuntu split these into dovecot-core, dovecot-imapd, and dovecot-lmtpd."
)

COMPOSER_MANUAL_INSTALL_COMMAND = (
    "sh",
    "-lc",
    "curl -fsSL https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer",
)


class OsFamily(str, Enum):
    DEBIAN = "debian"
    RHEL = "rhel"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class OsReleaseInfo:
    id: str
    id_like: str
    version_id: str
    pretty_name: str
    family: OsFamily

    @property
    def is_debian(self) -> bool:
        return self.family is OsFamily.DEBIAN

    @property
    def is_rhel(self) -> bool:
        return self.family is OsFamily.RHEL


@dataclass(frozen=True)
class PlatformPaths:
    auth_log: str
    nginx_user: str
    nginx_group: str
    web_root_group: str
    nginx_sites_available: str
    nginx_sites_enabled: str


@dataclass(frozen=True)
class ServiceSpec:
    """Logical service metadata for a single OS family."""

    unit: str
    units: tuple[str, ...]
    packages: tuple[str, ...]
    notes: str = ""


@dataclass(frozen=True)
class InstallStep:
    description: str
    command: tuple[str, ...]
    env: dict[str, str] = field(default_factory=dict)
    on_failure: InstallFailureMode = "abort"


@dataclass(frozen=True)
class PackageInstallPlan:
    key: str
    packages: tuple[str, ...]
    steps: tuple[InstallStep, ...]
    fallback_steps: tuple[InstallStep, ...] = ()
    notes: str = ""


def parse_os_release(content: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        value = raw_value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        values[key.upper()] = value
    return values


def classify_os_release(values: dict[str, str]) -> OsFamily:
    os_id = values.get("ID", "").lower()
    id_like = values.get("ID_LIKE", "").lower().split()

    if os_id in DEBIAN_IDS or "debian" in id_like:
        return OsFamily.DEBIAN
    if os_id in RHEL_IDS or "rhel" in id_like or "fedora" in id_like:
        return OsFamily.RHEL
    return OsFamily.UNKNOWN


def detect_os(path: Path | None = None) -> OsReleaseInfo:
    release_path = path or OS_RELEASE_PATH
    if not release_path.is_file():
        return OsReleaseInfo(
            id="unknown",
            id_like="",
            version_id="",
            pretty_name="Unknown",
            family=OsFamily.UNKNOWN,
        )

    values = parse_os_release(release_path.read_text(encoding="utf-8"))
    return OsReleaseInfo(
        id=values.get("ID", "unknown").lower(),
        id_like=values.get("ID_LIKE", "").lower(),
        version_id=values.get("VERSION_ID", ""),
        pretty_name=values.get("PRETTY_NAME", values.get("NAME", "Unknown")),
        family=classify_os_release(values),
    )


def current_os() -> OsReleaseInfo:
    cached = os.environ.get("SYSAGENT_OS_FAMILY")
    if cached in {OsFamily.DEBIAN.value, OsFamily.RHEL.value, OsFamily.UNKNOWN.value}:
        family = OsFamily(cached)
        return OsReleaseInfo(
            id=os.environ.get("SYSAGENT_OS_ID", "override"),
            id_like=os.environ.get("SYSAGENT_OS_ID_LIKE", ""),
            version_id=os.environ.get("SYSAGENT_OS_VERSION_ID", ""),
            pretty_name=os.environ.get("SYSAGENT_OS_PRETTY_NAME", f"Override ({family.value})"),
            family=family,
        )
    return detect_os()


def is_debian(info: OsReleaseInfo | None = None) -> bool:
    return (info or current_os()).family is OsFamily.DEBIAN


def is_rhel(info: OsReleaseInfo | None = None) -> bool:
    return (info or current_os()).family is OsFamily.RHEL


def is_almalinux(info: OsReleaseInfo | None = None) -> bool:
    return (info or current_os()).id == "almalinux"


def os_family_name(info: OsReleaseInfo | None = None) -> OsFamilyName:
    family = (info or current_os()).family
    if family is OsFamily.DEBIAN:
        return "debian"
    if family is OsFamily.RHEL:
        return "rhel"
    return "unknown"


def package_manager(info: OsReleaseInfo | None = None) -> PackageManagerName:
    family = (info or current_os()).family
    if family is OsFamily.RHEL:
        return "dnf"
    return "apt"


def firewall_backend(info: OsReleaseInfo | None = None) -> FirewallBackendName:
    if is_rhel(info):
        return "firewalld"
    return "ufw"


PACKAGE_SETS: dict[OsFamily, dict[str, tuple[str, ...]]] = {
    OsFamily.DEBIAN: {
        "base": (
            "ca-certificates",
            "curl",
            "gnupg",
            "git",
            "nginx",
            "certbot",
            "python3-certbot-nginx",
            "postgresql",
            "postgresql-contrib",
            "redis-server",
            "bind9",
            "bind9utils",
            "dnsutils",
            "ufw",
            "python3",
            "python3-venv",
            "python3-pip",
            "unzip",
            "zip",
            "openssl",
            "build-essential",
            "acl",
            "lsof",
            "psmisc",
        ),
        "nginx": ("nginx",),
        "bind9": ("bind9", "bind9utils", "bind9-doc"),
        "postfix": ("postfix",),
        "dovecot": DEBIAN_DOVECOT_PACKAGES,
        "redis": ("redis-server",),
        "postgresql": ("postgresql", "postgresql-contrib"),
        "certbot": ("certbot", "python3-certbot-nginx"),
        "php_runtime": (
            "php-cli",
            "php-fpm",
            "php-pgsql",
            "php-mysql",
            "php-xml",
            "php-mbstring",
            "php-curl",
            "php-zip",
        ),
        "golang": ("golang-go",),
        "composer": ("composer",),
    },
    OsFamily.RHEL: {
        "base": (
            "ca-certificates",
            "curl",
            "gnupg2",
            "git",
            "nginx",
            "postgresql-server",
            "postgresql-contrib",
            "redis",
            "bind",
            "bind-utils",
            "firewalld",
            "python3",
            "python3-pip",
            "unzip",
            "zip",
            "openssl",
            "gcc",
            "gcc-c++",
            "make",
            "automake",
            "autoconf",
            "libtool",
            "acl",
            "lsof",
            "psmisc",
            "policycoreutils-python-utils",
        ),
        "nginx": ("nginx",),
        "bind9": ("bind", "bind-utils"),
        "postfix": ("postfix",),
        "dovecot": RHEL_DOVECOT_PACKAGES,
        "redis": ("redis",),
        "postgresql": ("postgresql-server", "postgresql-contrib"),
        "certbot": RHEL_CERTBOT_PACKAGES,
        "php_runtime": (
            "php",
            "php-fpm",
            "php-pgsql",
            "php-mysqlnd",
            "php-xml",
            "php-mbstring",
            "php-curl",
            "php-zip",
        ),
        "golang": ("golang",),
        "composer": RHEL_COMPOSER_PACKAGES,
    },
}

# Package keys that require EPEL on AlmaLinux/RHEL before dnf install.
EPEL_PACKAGE_KEYS = frozenset({"certbot", "composer"})

SERVICE_SPECS: dict[OsFamily, dict[str, ServiceSpec]] = {
    OsFamily.DEBIAN: {
        "nginx": ServiceSpec(unit="nginx", units=("nginx",), packages=("nginx",)),
        "bind9": ServiceSpec(unit="bind9", units=("bind9", "named"), packages=("bind9", "bind9utils", "bind9-doc")),
        "postfix": ServiceSpec(unit="postfix", units=("postfix",), packages=("postfix",)),
        "dovecot": ServiceSpec(
            unit="dovecot",
            units=("dovecot",),
            packages=DEBIAN_DOVECOT_PACKAGES,
            notes="Split packages: core + imapd + lmtpd.",
        ),
        "redis": ServiceSpec(unit="redis-server", units=("redis-server", "redis"), packages=("redis-server",)),
        "postgresql": ServiceSpec(unit="postgresql", units=("postgresql",), packages=("postgresql", "postgresql-contrib")),
    },
    OsFamily.RHEL: {
        "nginx": ServiceSpec(unit="nginx", units=("nginx",), packages=("nginx",)),
        "bind9": ServiceSpec(unit="named", units=("named", "bind9"), packages=("bind", "bind-utils")),
        "postfix": ServiceSpec(unit="postfix", units=("postfix",), packages=("postfix",)),
        "dovecot": ServiceSpec(
            unit="dovecot",
            units=("dovecot",),
            packages=RHEL_DOVECOT_PACKAGES,
            notes=DOVECOT_RHEL_NOTES,
        ),
        "redis": ServiceSpec(unit="redis", units=("redis", "redis-server"), packages=("redis",)),
        "postgresql": ServiceSpec(
            unit="postgresql",
            units=("postgresql",),
            packages=("postgresql-server", "postgresql-contrib"),
        ),
    },
}

PLATFORM_PATHS: dict[OsFamily, PlatformPaths] = {
    OsFamily.DEBIAN: PlatformPaths(
        auth_log="/var/log/auth.log",
        nginx_user="www-data",
        nginx_group="www-data",
        web_root_group="www-data",
        nginx_sites_available="/etc/nginx/sites-available",
        nginx_sites_enabled="/etc/nginx/sites-enabled",
    ),
    OsFamily.RHEL: PlatformPaths(
        auth_log="/var/log/secure",
        nginx_user="nginx",
        nginx_group="nginx",
        web_root_group="nginx",
        nginx_sites_available="/etc/nginx/conf.d",
        nginx_sites_enabled="/etc/nginx/conf.d",
    ),
}

RUNTIME_TOOL_KEYS = frozenset({"composer", "golang", "php_runtime", "pnpm", "yarn", "uv"})


def _resolve_family(info: OsReleaseInfo | None = None) -> OsFamily:
    family = (info or current_os()).family
    if family is OsFamily.UNKNOWN:
        return OsFamily.DEBIAN
    return family


def packages_for(key: str, info: OsReleaseInfo | None = None) -> list[str]:
    family = _resolve_family(info)
    package_set = PACKAGE_SETS.get(family, PACKAGE_SETS[OsFamily.DEBIAN])
    if key not in package_set:
        raise KeyError(f"Unknown package key '{key}' for family '{family.value}'")
    return list(package_set[key])


def package_requires_epel(key: str, info: OsReleaseInfo | None = None) -> bool:
    return is_rhel(info) and key in EPEL_PACKAGE_KEYS


def epel_prerequisite_steps(info: OsReleaseInfo | None = None) -> tuple[InstallStep, ...]:
    if not is_rhel(info):
        return ()
    return (
        InstallStep(
            "Enable CRB repository (required by EPEL on AlmaLinux 9)",
            CRB_ENABLE_COMMAND,
            on_failure="continue",
        ),
        InstallStep("Install EPEL repository", EPEL_INSTALL_COMMAND),
    )


def _single_package_install_step(key: str, info: OsReleaseInfo | None = None) -> InstallStep:
    packages = packages_for(key, info)
    return InstallStep(
        f"Install {key} packages",
        tuple(package_install_command(packages, info)),
        env=package_install_env(info),
    )


def certbot_install_plan(info: OsReleaseInfo | None = None) -> PackageInstallPlan:
    family = _resolve_family(info)
    packages = tuple(packages_for("certbot", info))
    if family is OsFamily.RHEL:
        return PackageInstallPlan(
            key="certbot",
            packages=packages,
            steps=(
                *epel_prerequisite_steps(info),
                InstallStep(
                    "Install Certbot with Nginx plugin from EPEL",
                    tuple(package_install_command(list(packages), info)),
                    env=package_install_env(info),
                ),
            ),
            notes=(
                "AlmaLinux 9 provides certbot and python3-certbot-nginx via EPEL. "
                "Enable CRB, install epel-release, then install both packages."
            ),
        )
    return PackageInstallPlan(
        key="certbot",
        packages=packages,
        steps=(_single_package_install_step("certbot", info),),
        notes="Certbot is available from Ubuntu repositories.",
    )


def composer_install_plan(info: OsReleaseInfo | None = None) -> PackageInstallPlan:
    family = _resolve_family(info)
    packages = tuple(packages_for("composer", info))
    if family is OsFamily.RHEL:
        return PackageInstallPlan(
            key="composer",
            packages=packages,
            steps=(
                *epel_prerequisite_steps(info),
                InstallStep(
                    "Install Composer from EPEL",
                    tuple(package_install_command(list(packages), info)),
                    env=package_install_env(info),
                ),
            ),
            fallback_steps=(
                InstallStep(
                    "Install Composer via official installer (fallback if EPEL package unavailable)",
                    COMPOSER_MANUAL_INSTALL_COMMAND,
                ),
            ),
            notes=(
                "Primary: EPEL composer RPM (includes php-cli dependency). "
                "Fallback: getcomposer.org installer to /usr/local/bin/composer."
            ),
        )
    return PackageInstallPlan(
        key="composer",
        packages=packages,
        steps=(_single_package_install_step("composer", info),),
        notes="Composer is available from Ubuntu repositories.",
    )


def dovecot_install_plan(info: OsReleaseInfo | None = None) -> PackageInstallPlan:
    spec = service_spec("dovecot", info)
    return PackageInstallPlan(
        key="dovecot",
        packages=spec.packages,
        steps=(_single_package_install_step("dovecot", info),),
        notes=spec.notes,
    )


def install_plan_for(key: str, info: OsReleaseInfo | None = None) -> PackageInstallPlan:
    if key == "certbot":
        return certbot_install_plan(info)
    if key == "composer":
        return composer_install_plan(info)
    if key == "dovecot":
        return dovecot_install_plan(info)

    packages = tuple(packages_for(key, info))
    return PackageInstallPlan(
        key=key,
        packages=packages,
        steps=(_single_package_install_step(key, info),),
    )


def install_steps_for(key: str, info: OsReleaseInfo | None = None) -> list[InstallStep]:
    plan = install_plan_for(key, info)
    return list(plan.steps)


def service_spec(key: str, info: OsReleaseInfo | None = None) -> ServiceSpec:
    family = _resolve_family(info)
    specs = SERVICE_SPECS.get(family, SERVICE_SPECS[OsFamily.DEBIAN])
    if key not in specs:
        raise KeyError(f"Unknown service key '{key}' for family '{family.value}'")
    return specs[key]


def service_unit(key: str, info: OsReleaseInfo | None = None) -> str:
    return service_spec(key, info).unit


def service_units(key: str, info: OsReleaseInfo | None = None) -> list[str]:
    return list(service_spec(key, info).units)


def platform_paths(info: OsReleaseInfo | None = None) -> PlatformPaths:
    family = _resolve_family(info)
    return PLATFORM_PATHS[family]


def package_install_command(packages: list[str], info: OsReleaseInfo | None = None) -> list[str]:
    manager = package_manager(info)
    if manager == "dnf":
        return ["dnf", "install", "-y", *packages]
    return ["apt-get", "install", "-y", *packages]


def package_install_env(info: OsReleaseInfo | None = None) -> dict[str, str]:
    if package_manager(info) == "apt":
        return {"DEBIAN_FRONTEND": "noninteractive"}
    return {}


def runtime_tool_install_plan(tool: str, info: OsReleaseInfo | None = None) -> PackageInstallPlan:
    npm_global = {
        "pnpm": ("pnpm", ("npm", "install", "-g", "pnpm")),
        "yarn": ("yarn", ("npm", "install", "-g", "yarn")),
    }
    if tool in npm_global:
        key, command = npm_global[tool]
        return PackageInstallPlan(
            key=key,
            packages=(),
            steps=(InstallStep(f"Install {tool} globally via npm", command),),
        )
    if tool == "uv":
        return PackageInstallPlan(
            key="uv",
            packages=(),
            steps=(InstallStep("Install uv via pip", ("pip3", "install", "uv")),),
        )
    if tool == "composer":
        return composer_install_plan(info)

    package_key = {"php": "php_runtime", "go": "golang"}.get(tool, tool)
    if package_key not in PACKAGE_SETS[_resolve_family(info)]:
        raise KeyError(f"Unknown runtime tool '{tool}'")
    return install_plan_for(package_key, info)


def runtime_tool_install_command(tool: str, info: OsReleaseInfo | None = None) -> list[str]:
    plan = runtime_tool_install_plan(tool, info)
    primary = plan.steps[-1] if plan.steps else None
    if primary is None:
        raise KeyError(f"No install steps defined for runtime tool '{tool}'")
    return list(primary.command)


def platform_summary(info: OsReleaseInfo | None = None) -> dict[str, object]:
    resolved = info or current_os()
    family = _resolve_family(resolved)
    paths = platform_paths(resolved)
    try:
        from app.config import settings

        nginx_sites_available = settings.nginx_sites_available.strip() or paths.nginx_sites_available
        nginx_sites_enabled = settings.nginx_sites_enabled.strip() or paths.nginx_sites_enabled
    except Exception:
        nginx_sites_available = os.environ.get("NGINX_SITES_AVAILABLE", "").strip() or paths.nginx_sites_available
        nginx_sites_enabled = os.environ.get("NGINX_SITES_ENABLED", "").strip() or paths.nginx_sites_enabled
    incomplete = sorted(key for key in INCOMPLETE_ON_ALMA if family is OsFamily.RHEL)
    dovecot = service_spec("dovecot", resolved)
    return {
        "id": resolved.id,
        "prettyName": resolved.pretty_name,
        "versionId": resolved.version_id,
        "family": family.value,
        "packageManager": package_manager(resolved),
        "firewallBackend": firewall_backend(resolved),
        "paths": {
            "authLog": paths.auth_log,
            "nginxUser": paths.nginx_user,
            "nginxGroup": paths.nginx_group,
            "webRootGroup": paths.web_root_group,
            "nginxSitesAvailable": nginx_sites_available,
            "nginxSitesEnabled": nginx_sites_enabled,
        },
        "packages": {
            "certbot": list(certbot_install_plan(resolved).packages),
            "composer": list(composer_install_plan(resolved).packages),
            "dovecot": list(dovecot.packages),
        },
        "dovecotNotes": dovecot.notes,
        "incompleteOnAlma": incomplete,
    }
