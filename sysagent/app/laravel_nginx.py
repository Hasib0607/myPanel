def nginx_proxy_headers(upstream_port: int) -> str:
    return (
        "        proxy_http_version 1.1;\n"
        f"        proxy_pass http://127.0.0.1:{upstream_port};\n"
        "        proxy_set_header Host $http_host;\n"
        "        proxy_set_header X-Forwarded-Host $host;\n"
        "        proxy_set_header X-Forwarded-Port $server_port;\n"
        "        proxy_set_header Forwarded \"proto=$scheme;host=$http_host\";\n"
        "        proxy_set_header X-Real-IP $remote_addr;\n"
        "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
        "        proxy_set_header X-Forwarded-Proto $scheme;\n"
        "        proxy_set_header Upgrade $http_upgrade;\n"
        "        proxy_set_header Connection \"upgrade\";\n"
        "        proxy_connect_timeout 10s;\n"
        "        proxy_send_timeout 60s;\n"
        "        proxy_read_timeout 60s;\n"
        f"        proxy_redirect http://localhost:{upstream_port}/ $scheme://$host/;\n"
        f"        proxy_redirect https://localhost:{upstream_port}/ https://$host/;\n"
        f"        proxy_redirect http://127.0.0.1:{upstream_port}/ $scheme://$host/;\n"
        f"        proxy_redirect https://127.0.0.1:{upstream_port}/ https://$host/;\n"
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
        "    location ~* \\.(?:css|js|mjs|map|ico|gif|jpe?g|png|svg|webp|woff2?|ttf|eot|otf)$ {\n"
        "        try_files $uri =404;\n"
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
