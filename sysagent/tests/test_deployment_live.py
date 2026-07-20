import sys
import types
import unittest
from unittest import mock

psutil = types.ModuleType("psutil")
sys.modules.setdefault("psutil", psutil)

fastapi = types.ModuleType("fastapi")


class HTTPException(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


fastapi.HTTPException = HTTPException
fastapi.APIRouter = lambda *args, **kwargs: types.SimpleNamespace(
    get=lambda *route_args, **route_kwargs: (lambda fn: fn),
    post=lambda *route_args, **route_kwargs: (lambda fn: fn),
    patch=lambda *route_args, **route_kwargs: (lambda fn: fn),
    delete=lambda *route_args, **route_kwargs: (lambda fn: fn),
)
sys.modules.setdefault("fastapi", fastapi)

pydantic_settings = types.ModuleType("pydantic_settings")


class BaseSettings:
    def __init__(self, **values):
        for key, value in values.items():
            setattr(self, key, value)


pydantic_settings.BaseSettings = BaseSettings
pydantic_settings.SettingsConfigDict = lambda **kwargs: kwargs
sys.modules.setdefault("pydantic_settings", pydantic_settings)

from app.command import run_command
from app.routers.deployments import HealthRequest, PortStatusRequest, _curl_public_route, _supervisor_process_mismatch, port_status


class DeploymentLiveCommandTests(unittest.TestCase):
    def test_allow_live_true_runs_even_when_global_live_disabled(self) -> None:
        with mock.patch("app.command.settings") as settings:
            settings.allow_live_system_commands = False
            settings.deployment_command_timeout_seconds = 900
            with mock.patch("app.command.subprocess.Popen") as popen:
                process = mock.Mock()
                process.communicate.return_value = ("ok", "")
                process.returncode = 0
                process.pid = 1234
                popen.return_value = process

                with mock.patch("app.command.os.getpgid", return_value=1234):
                    result = run_command(["echo", "live"], allow_live=True)

        self.assertFalse(result["dryRun"])
        self.assertEqual(result["returncode"], 0)
        popen.assert_called_once()

    def test_allow_live_false_dry_runs_when_global_live_disabled(self) -> None:
        with mock.patch("app.command.settings") as settings:
            settings.allow_live_system_commands = False
            result = run_command(["echo", "dry"], allow_live=False)

        self.assertTrue(result["dryRun"])
        self.assertTrue(result["liveCommandsDisabled"])

    def test_supervisor_health_reports_missing_runtime_tool(self) -> None:
        body = HealthRequest(
            deploymentId="dep_1",
            port=3000,
            processName="laravel-app",
            processManager="SUPERVISOR",
        )
        with mock.patch("app.routers.deployments.shutil.which", return_value=None):
            result = _supervisor_process_mismatch(body)

        self.assertEqual(
            result,
            "Supervisor is not installed. Approve the install-supervisor runtime tool action, then redeploy.",
        )

    def test_public_route_probe_uses_real_child_host_for_wildcard(self) -> None:
        calls: list[list[str]] = []

        def fake_run_command(command: list[str], **_kwargs):
            calls.append(command)
            return {"returncode": 0, "stdout": "ok\n__http_code=200\n__effective_url=http://vps-panel-wildcard-probe.ebitan.store/", "stderr": ""}

        with mock.patch("app.routers.deployments.letsencrypt_certificate_exists", return_value=False):
            with mock.patch("app.routers.deployments.run_command", side_effect=fake_run_command):
                result = _curl_public_route("*.ebitan.store", "/", "/var/www/app", "NEXTJS", require_https=True)

        self.assertEqual(result["returncode"], 0)
        self.assertTrue(calls)
        command_text = " ".join(calls[0])
        self.assertIn("Host: vps-panel-wildcard-probe.ebitan.store", command_text)
        self.assertIn("http://vps-panel-wildcard-probe.ebitan.store/", command_text)
        self.assertNotIn("*.ebitan.store", command_text)

    def test_port_status_reuses_pm2_process_with_same_cwd(self) -> None:
        body = PortStatusRequest(
            rootPath="/var/www/accounts/demo/deployments/app",
            port=10012,
            processName="new-slug",
            processManager="PM2",
        )
        owner = {
            "name": "old-slug",
            "cwd": "/var/www/accounts/demo/deployments/app",
            "port": 10012,
        }

        with mock.patch("app.routers.deployments.path_info", return_value={"allowed": True}):
            with mock.patch("app.routers.deployments._pm2_owner_for_port", return_value=owner):
                result = port_status(body)

        self.assertFalse(result["occupied"])
        self.assertTrue(result["reusable"])
        self.assertTrue(result["cwdMatches"])


if __name__ == "__main__":
    unittest.main()
