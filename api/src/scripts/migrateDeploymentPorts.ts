import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

function deploymentPortRange() {
  if (env.DEPLOYMENT_PORT_START > env.DEPLOYMENT_PORT_END) {
    throw new Error("DEPLOYMENT_PORT_START must be lower than or equal to DEPLOYMENT_PORT_END");
  }
  return { start: env.DEPLOYMENT_PORT_START, end: env.DEPLOYMENT_PORT_END };
}

function reservedDeploymentPorts() {
  const ports = new Set<number>();
  for (const rawPort of env.DEPLOYMENT_RESERVED_PORTS.split(",")) {
    const port = Number(rawPort.trim());
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  ports.add(env.PANEL_PORT);
  const loginPort = Number(env.PANEL_LOGIN_PORT ?? 8453);
  if (Number.isInteger(loginPort) && loginPort > 0 && loginPort <= 65535) ports.add(loginPort);
  const accountPort = Number(env.CPANEL_LOGIN_PORT ?? 3138);
  if (Number.isInteger(accountPort) && accountPort > 0 && accountPort <= 65535) ports.add(accountPort);
  return ports;
}

async function main() {
  const { start, end } = deploymentPortRange();
  const reserved = reservedDeploymentPorts();
  const deployments = await prisma.deployment.findMany({
    select: { id: true, name: true, slug: true, port: true },
    orderBy: [{ port: "asc" }, { createdAt: "asc" }]
  });
  const used = new Set(deployments.map((deployment) => deployment.port));
  let candidate = start;

  for (const deployment of deployments) {
    const unsafe = deployment.port < start || deployment.port > end || reserved.has(deployment.port);
    if (!unsafe) continue;

    while (candidate <= end && (used.has(candidate) || reserved.has(candidate))) candidate += 1;
    if (candidate > end) throw new Error(`No free deployment ports remain in ${start}-${end}`);

    used.delete(deployment.port);
    used.add(candidate);
    await prisma.deployment.update({ where: { id: deployment.id }, data: { port: candidate } });
    console.log(`${deployment.slug}: ${deployment.port} -> ${candidate}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
