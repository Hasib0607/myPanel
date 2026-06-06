from pydantic_settings import BaseSettings, SettingsConfigDict

from app.env_loader import env_flag, panel_env_path, reload_panel_env

# Deployment lifecycle commands always execute live. The global live flag still
# protects guardian, firewall, and file-manager operations on the host.
DEPLOYMENT_COMMANDS_LIVE = True

__all__ = ["DEPLOYMENT_COMMANDS_LIVE", "Settings", "panel_env_path", "reload_panel_env", "settings"]


class Settings(BaseSettings):
    allow_live_system_commands: bool = True
    allow_live_file_manager: bool = True
    allow_live_dns: bool = True
    allow_live_nginx: bool = True
    allow_live_ssl: bool = True
    allow_live_backup: bool = True
    deployment_command_timeout_seconds: int = 900
    ssl_certbot_timeout_seconds: int = 1800
    deployment_log_root: str = "/var/log/vps-panel/deployments"
    backup_root: str = "/var/backups/vps-panel"
    file_manager_root: str = "/var/www"
    guardian_file_watch_roots: str = "/var/www"
    nginx_sites_available: str = ""
    nginx_sites_enabled: str = ""

    model_config = SettingsConfigDict(
        env_file=panel_env_path(),
        env_file_encoding="utf-8",
        extra="ignore",
    )


_settings = Settings()


class _SettingsAccessor:
    """Expose settings while resolving live-mode flags from os.environ on each read."""

    def __getattr__(self, name: str):
        if name == "allow_live_system_commands":
            return env_flag("ALLOW_LIVE_SYSTEM_COMMANDS", _settings.allow_live_system_commands)
        if name == "allow_live_file_manager":
            return env_flag("ALLOW_LIVE_FILE_MANAGER", _settings.allow_live_file_manager)
        if name == "allow_live_dns":
            return env_flag("ALLOW_LIVE_DNS", _settings.allow_live_dns)
        if name == "allow_live_nginx":
            return env_flag("ALLOW_LIVE_NGINX", _settings.allow_live_nginx)
        if name == "allow_live_ssl":
            return env_flag("ALLOW_LIVE_SSL", _settings.allow_live_ssl)
        if name == "allow_live_backup":
            return env_flag("ALLOW_LIVE_BACKUP", _settings.allow_live_backup)
        return getattr(_settings, name)


settings = _SettingsAccessor()
