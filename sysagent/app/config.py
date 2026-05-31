from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    allow_live_system_commands: bool = False
    allow_live_file_manager: bool = True
    allow_live_dns: bool = True
    allow_live_nginx: bool = True
    allow_live_ssl: bool = True
    allow_live_backup: bool = False
    deployment_command_timeout_seconds: int = 900
    deployment_log_root: str = "/var/log/vps-panel/deployments"
    backup_root: str = "/var/backups/vps-panel"
    file_manager_root: str = "/var/www"
    guardian_file_watch_roots: str = "/var/www"
    nginx_sites_available: str = ""
    nginx_sites_enabled: str = ""

    class Config:
        env_prefix = ""
        env_file = ".env"
        extra = "ignore"


settings = Settings()
