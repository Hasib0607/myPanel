import unittest
from unittest.mock import patch

from app.routers import deployments


class WildcardRenewalRouteTests(unittest.TestCase):
    def test_wildcard_renewal_checks_existing_exact_child_routes(self):
        config = '''# configuration file /etc/nginx/conf.d/admin.conf:
server {
    listen 443 ssl;
    server_name admin.example.com;
    add_header X-VPS-Panel-Route "admin-route" always;
}
'''
        with patch.object(deployments, "nginx_config_dump", return_value=(config, {"returncode": 0})), \
             patch.object(deployments, "run_command", return_value={
                 "returncode": 0, "stdout": "HTTP/1.1 200 OK\r\nX-VPS-Panel-Route: admin-route\r\n", "stderr": ""
             }) as command:
            result = deployments._wildcard_exact_child_route_probe("*.example.com", "wildcard-route", require_https=True)
        self.assertEqual(result["returncode"], 0)
        command.assert_called_once()
        self.assertIn("https://admin.example.com/", command.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
