from __future__ import annotations
def nginx_proxy_headers(upstream_port: int, *, loopback_host: bool = False) -> str:
    host_header = f"127.0.0.1:{upstream_port}" if loopback_host else "$http_host"
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
        "        proxy_set_header Upgrade $http_upgrade;\n"
        "        proxy_set_header Connection \"upgrade\";\n"
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


def nginx_upstream_proxy_locations(upstream_port: int, *, loopback_host: bool = False) -> str:
    """Proxy all traffic to the app process (Vite preview, Next.js, Node APIs)."""
    return (
        "    location / {\n"
        f"{nginx_proxy_headers(upstream_port, loopback_host=loopback_host)}"
        "    }\n"
    )


def nginx_spa_static_locations(public_root: str, upstream_port: int) -> str:
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
    framework: str | None,
    public_root: str,
    upstream_port: int,
    fallback_error_page: str,
    fallback_location: str,
    loopback_proxy_host: bool = False,
) -> str:
    normalized = (framework or "").upper()
    if normalized in {"NODEJS", "NEXTJS", "PYTHON", "GO"}:
        return nginx_upstream_proxy_locations(upstream_port, loopback_host=loopback_proxy_host)
    if normalized == "STATIC":
        return nginx_spa_static_locations(public_root, upstream_port)
    return nginx_laravel_app_locations(
        public_root=public_root,
        upstream_port=upstream_port,
        fallback_error_page=fallback_error_page,
        fallback_location=fallback_location,
    )


def nginx_laravel_app_locations(
    *,
    public_root: str,
    upstream_port: int,
    fallback_error_page: str,
    fallback_location: str,
) -> str:
    return (
        f"    root {public_root};\n"
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
        "        try_files $uri @deployment_upstream;\n"
        "        expires 7d;\n"
        "        access_log off;\n"
        "        add_header Cache-Control \"public\";\n"
        "    }\n"
        "\n"
        f"    location / {{\n"
        f"{fallback_error_page}"
        "        try_files $uri @deployment_upstream;\n"
        "    }\n"
        "\n"
        "    location @deployment_upstream {\n"
        f"{nginx_proxy_headers(upstream_port)}"
        "    }\n"
        f"{fallback_location}"
    )
