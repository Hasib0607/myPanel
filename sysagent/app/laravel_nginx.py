from __future__ import annotations

import re
from pathlib import Path


def laravel_fpm_pool_name(deployment_id: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_.-]+", "-", deployment_id).strip("-")
    return f"vps-panel-{cleaned or 'laravel'}"


def laravel_fpm_socket(deployment_id: str) -> str:
    socket_dir = Path("/run/php-fpm")
    if not socket_dir.exists() and Path("/run/php").exists():
        socket_dir = Path("/run/php")
    return str(socket_dir / f"{laravel_fpm_pool_name(deployment_id)}.sock")


def nginx_proxy_headers(upstream_port: int, *, loopback_host: bool = False, websocket_upgrade: bool = False) -> str:
    host_header = f"127.0.0.1:{upstream_port}" if loopback_host else "$http_host"
    upgrade_headers = (
        "        proxy_set_header Upgrade $http_upgrade;\n"
        "        proxy_set_header Connection \"upgrade\";\n"
        if websocket_upgrade
        else "        proxy_set_header Connection \"\";\n"
    )
    return (
        "        proxy_http_version 1.1;\n"
        f"        proxy_pass http://127.0.0.1:{upstream_port};\n"
        f"        proxy_set_header Host {host_header};\n"
        "        proxy_set_header X-Forwarded-Host $host;\n"
        "        proxy_set_header X-Forwarded-Port $server_port;\n"
        "        proxy_set_header Forwarded \"proto=$scheme;host=$http_host\";\n"
        "        proxy_set_header X-Real-IP $remote_addr;\n"
        "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
        "        proxy_set_header X-Forwarded-Proto $scheme;\n"
        "        proxy_set_header X-Forwarded-Ssl $https;\n"
        "        proxy_set_header HTTPS $https;\n"
        f"{upgrade_headers}"
        "        proxy_connect_timeout 10s;\n"
        "        proxy_request_buffering off;\n"
        "        proxy_buffering off;\n"
        "        proxy_send_timeout 3600s;\n"
        "        proxy_read_timeout 3600s;\n"
        f"        proxy_redirect http://localhost:{upstream_port}/ $scheme://$host/;\n"
        f"        proxy_redirect https://localhost:{upstream_port}/ https://$host/;\n"
        f"        proxy_redirect http://127.0.0.1:{upstream_port}/ $scheme://$host/;\n"
        f"        proxy_redirect https://127.0.0.1:{upstream_port}/ https://$host/;\n"
    )


def nginx_upstream_proxy_locations(upstream_port: int, *, loopback_host: bool = False, websocket_upgrade: bool = False) -> str:
    """Proxy all traffic to the app process (Vite preview, Next.js, Node APIs)."""
    return (
        "    location / {\n"
        f"{nginx_proxy_headers(upstream_port, loopback_host=loopback_host, websocket_upgrade=websocket_upgrade)}"
        "    }\n"
    )


def nginx_spa_static_locations(public_root: str, upstream_port: int, fallback_error_page: str) -> str:
    """Serve a built SPA from disk; fall back to the upstream for missing routes."""
    return (
        f"    root {public_root};\n"
        "    index index.html;\n"
        "\n"
        "    location ~* \\.(?:css|js|mjs|map|ico|gif|jpe?g|png|svg|webp|woff2?|ttf|eot|otf)$ {\n"
        "        try_files $uri =404;\n"
        "        expires 7d;\n"
        "        access_log off;\n"
        "        add_header Cache-Control \"public\";\n"
        "    }\n"
        "\n"
        "    location / {\n"
        "        try_files $uri $uri/ /index.html;\n"
        "    }\n"
        "\n"
        "    location @deployment_upstream {\n"
        f"{fallback_error_page}"
        f"{nginx_proxy_headers(upstream_port)}"
        "    }\n"
    )


def nginx_app_locations(
    *,
    deployment_id: str,
    framework: str | None,
    public_root: str,
    upstream_port: int,
    fallback_error_page: str,
    fallback_location: str,
    loopback_proxy_host: bool = False,
) -> str:
    normalized = (framework or "").upper()
    if normalized in {"NODEJS", "NEXTJS", "PYTHON", "GO"}:
        # Never replace the public Host for Next.js. Its middleware combines Host
        # with X-Forwarded-Proto when constructing rewrite URLs; a loopback Host
        # would turn an HTTPS request into https://localhost:<plain-http-port>.
        effective_loopback_host = loopback_proxy_host and normalized == "NODEJS"
        websocket_upgrade = normalized in {"NODEJS", "NEXTJS"}
        return nginx_upstream_proxy_locations(upstream_port, loopback_host=effective_loopback_host, websocket_upgrade=websocket_upgrade)
    if normalized == "STATIC":
        return nginx_spa_static_locations(public_root, upstream_port, fallback_error_page)
    return nginx_laravel_app_locations(
        deployment_id=deployment_id,
        public_root=public_root,
        fallback_error_page=fallback_error_page,
        fallback_location=fallback_location,
    )


def nginx_laravel_app_locations(
    *,
    deployment_id: str,
    public_root: str,
    fallback_error_page: str,
    fallback_location: str,
) -> str:
    socket_path = laravel_fpm_socket(deployment_id)
    has_spa_index = Path(public_root, "index.html").exists()
    api_locations = (
        "    location ^~ /react-admin-api/ {\n"
        "        try_files $uri /index.php?$query_string;\n"
        "    }\n"
        "\n"
        "    location ^~ /api/ {\n"
        "        try_files $uri /index.php?$query_string;\n"
        "    }\n"
        "\n"
        "    location ^~ /sanctum/ {\n"
        "        try_files $uri /index.php?$query_string;\n"
        "    }\n"
        "\n"
    )
    root_location = (
        "    location / {\n"
        "        try_files $uri $uri/ /index.html;\n"
        "    }\n"
        if has_spa_index
        else
        "    location / {\n"
        "        try_files $uri /index.php?$query_string;\n"
        "    }\n"
    )
    return (
        f"    root {public_root};\n"
        "    index index.php;\n"
        "\n"
        "    # Compatibility for legacy Laravel templates that generate asset('/public/...') URLs.\n"
        "    location ~* ^/public/(.+\\.(?:css|js|mjs|map|ico|gif|jpe?g|png|svg|webp|woff2?|ttf|eot|otf))$ {\n"
        f"        alias {public_root}/$1;\n"
        "        expires 7d;\n"
        "        access_log off;\n"
        "        add_header Cache-Control \"public\";\n"
        "    }\n"
        "\n"
        "    location ~* \\.(?:css|js|mjs|map|ico|gif|jpe?g|png|svg|webp|woff2?|ttf|eot|otf)$ {\n"
        "        try_files $uri /index.php?$query_string;\n"
        "        expires 7d;\n"
        "        access_log off;\n"
        "        add_header Cache-Control \"public\";\n"
        "    }\n"
        "\n"
        f"{api_locations}"
        f"{root_location}"
        "\n"
        "    location = /index.php {\n"
        f"{fallback_error_page}"
        "        include fastcgi_params;\n"
        "        fastcgi_param SCRIPT_FILENAME $document_root/index.php;\n"
        "        fastcgi_param SCRIPT_NAME /index.php;\n"
        "        fastcgi_param HTTPS $https;\n"
        "        fastcgi_param HTTP_X_FORWARDED_PROTO $scheme;\n"
        "        fastcgi_param HTTP_X_FORWARDED_HOST $host;\n"
        "        fastcgi_param HTTP_X_FORWARDED_PORT $server_port;\n"
        f"        fastcgi_pass unix:{socket_path};\n"
        "        fastcgi_connect_timeout 10s;\n"
        "        fastcgi_send_timeout 60s;\n"
        "        fastcgi_read_timeout 60s;\n"
        "        fastcgi_buffering on;\n"
        "        fastcgi_buffers 16 16k;\n"
        "        fastcgi_buffer_size 32k;\n"
        "    }\n"
        f"{fallback_location}"
    )
