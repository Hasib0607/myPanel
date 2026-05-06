from fastapi import APIRouter

from app.command import run_command

router = APIRouter()


@router.get("")
def list_processes() -> dict:
    return {
        "pm2": run_command(["pm2", "jlist"]),
        "supervisor": run_command(["supervisorctl", "status"]),
    }


@router.post("/{manager}/{name}/{action}")
def control_process(manager: str, name: str, action: str) -> dict:
    if manager == "pm2":
        return run_command(["pm2", action, name])
    return run_command(["supervisorctl", action, name])
