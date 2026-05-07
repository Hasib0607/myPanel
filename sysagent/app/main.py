from fastapi import FastAPI

from app.routers import database, deployments, dns, files, firewall, mail_config, nginx, processes, ssl, system

app = FastAPI(title="VPS Panel System Agent", version="0.1.0")

app.include_router(system.router, prefix="/system", tags=["system"])
app.include_router(firewall.router, prefix="/firewall", tags=["firewall"])
app.include_router(deployments.router, prefix="/deployments", tags=["deployments"])
app.include_router(dns.router, prefix="/dns", tags=["dns"])
app.include_router(database.router, prefix="/database", tags=["database"])
app.include_router(nginx.router, prefix="/nginx", tags=["nginx"])
app.include_router(files.router, prefix="/files", tags=["files"])
app.include_router(processes.router, prefix="/processes", tags=["processes"])
app.include_router(ssl.router, prefix="/ssl", tags=["ssl"])
app.include_router(mail_config.router, prefix="/mail-config", tags=["mail-config"])


@app.get("/health")
def health() -> dict:
    return {"ok": True}
