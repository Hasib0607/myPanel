import sys
import types
import unittest

fastapi_module = types.ModuleType("fastapi")


class _APIRouter:
    def get(self, *_args, **_kwargs):
        return lambda func: func

    def post(self, *_args, **_kwargs):
        return lambda func: func

    def delete(self, *_args, **_kwargs):
        return lambda func: func


class _HTTPException(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


fastapi_module.APIRouter = _APIRouter
fastapi_module.HTTPException = _HTTPException
sys.modules.setdefault("fastapi", fastapi_module)

config_module = types.ModuleType("app.config")
config_module.settings = types.SimpleNamespace(backup_root="/tmp", allow_live_backup=False)
sys.modules.setdefault("app.config", config_module)

command_module = types.ModuleType("app.command")
command_module.run_command = lambda *_args, **_kwargs: {"returncode": 0, "stdout": "", "stderr": ""}
sys.modules.setdefault("app.command", command_module)

platform_module = types.ModuleType("app.platform")
platform_module.current_os = lambda: types.SimpleNamespace(is_rhel=False)
platform_module.package_install_command = lambda *_args, **_kwargs: ["true"]
platform_module.package_install_env = lambda *_args, **_kwargs: {}
sys.modules.setdefault("app.platform", platform_module)

from app.routers.backup import remote_archive_names, rclone_delete_remote_backup_commands


class BackupRemoteRetentionTests(unittest.TestCase):
    def test_remote_archive_names_keeps_archive_paths_only(self) -> None:
        stdout = "\n".join([
            "2026-06-15 11:02:03;2026-06-15/mypanel-scheduled-20260615-1101-20260615T050203Z.tar.gz",
            "2026-06-15 11:02:04;2026-06-15/mypanel-scheduled-20260615-1101-20260615T050203Z.tar.gz.sha256",
            "2026-06-14 23:02:03;2026-06-14/mypanel-scheduled-20260614-2301-20260614T170203Z.tar.gz.gpg",
            "2026-06-14 23:02:04;notes.txt",
        ])

        self.assertEqual(
            remote_archive_names(stdout),
            [
                "2026-06-15/mypanel-scheduled-20260615-1101-20260615T050203Z.tar.gz",
                "2026-06-14/mypanel-scheduled-20260614-2301-20260614T170203Z.tar.gz.gpg",
            ],
        )

    def test_remote_delete_commands_bypass_google_drive_trash(self) -> None:
        commands = rclone_delete_remote_backup_commands("mypanel-drive:vps-panel-backups/2026-06-15/mypanel-demo.tar.gz")

        self.assertIn("--drive-use-trash=false", commands[0])
        self.assertIn("--drive-use-trash=false", commands[1])
        self.assertIn("mypanel-demo.tar.gz.sha256", commands[1])


if __name__ == "__main__":
    unittest.main()
