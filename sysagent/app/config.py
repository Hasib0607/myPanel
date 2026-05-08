from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    allow_live_system_commands: bool = False
    allow_live_file_manager: bool = True
    allow_live_dns: bool = True
    allow_live_nginx: bool = True
    allow_live_ssl: bool = True
    deployment_command_timeout_seconds: int = 900
    file_manager_root: str = "/var/www"

    class Config:
        env_prefix = ""
        env_file = ".env"
        extra = "ignore"


settings = Settings()
