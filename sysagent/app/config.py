from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    allow_live_system_commands: bool = False
    allow_live_file_manager: bool = True
    file_manager_root: str = "/var/www"

    class Config:
        env_prefix = ""
        env_file = ".env"
        extra = "ignore"


settings = Settings()
