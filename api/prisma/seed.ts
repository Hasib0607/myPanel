import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.superadminSecurity.upsert({
    where: { id: "superadmin" },
    create: {},
    update: {}
  });

  const example = await prisma.domain.upsert({
    where: { name: "example.com" },
    update: {},
    create: {
      name: "example.com",
      status: "ACTIVE",
      sslEnabled: false,
      dnsRecords: {
        create: [
          { type: "A", name: "@", value: "127.0.0.1" },
          { type: "A", name: "www", value: "127.0.0.1" },
          { type: "MX", name: "@", value: "mail.example.com", priority: 10 },
          { type: "A", name: "mail", value: "127.0.0.1" },
          { type: "TXT", name: "@", value: "v=spf1 ip4:127.0.0.1 ~all" },
          { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=quarantine; rua=mailto:admin@example.com" }
        ]
      },
      subdomains: {
        create: [
          { name: "app", target: "127.0.0.1", sslEnabled: false }
        ]
      }
    }
  });

  const passwordHash = await bcrypt.hash("LocalMailboxOnly!ChangeMe-2026", 12);
  const mailAccount = await prisma.mailAccount.upsert({
    where: {
      domainId_username: {
        domainId: example.id,
        username: "admin"
      }
    },
    update: {},
    create: {
      domainId: example.id,
      username: "admin",
      passwordHash,
      quotaMb: 1024
    }
  });

  await prisma.mail.upsert({
    where: { messageId: "seed-welcome@example.com" },
    update: {},
    create: {
      accountId: mailAccount.id,
      messageId: "seed-welcome@example.com",
      fromAddress: "panel@example.com",
      toAddress: "admin@example.com",
      subject: "Welcome to VPS Panel webmail",
      folder: "INBOX",
      isRead: false,
      receivedAt: new Date("2026-05-03T08:00:00.000Z")
    }
  });

  await prisma.mail.upsert({
    where: { messageId: "seed-deliverability@example.com" },
    update: {},
    create: {
      accountId: mailAccount.id,
      messageId: "seed-deliverability@example.com",
      fromAddress: "postmaster@example.com",
      toAddress: "admin@example.com",
      subject: "Check SPF, DKIM, DMARC, and PTR before live sending",
      folder: "INBOX",
      isRead: true,
      isStarred: true,
      receivedAt: new Date("2026-05-03T08:05:00.000Z")
    }
  });

  await prisma.deployment.upsert({
    where: { slug: "example-nextjs-app" },
    update: {
      domainId: example.id,
      sourceProvider: "GITHUB",
      githubOwner: "example",
      githubRepo: "example-nextjs-app",
      gitUrl: "https://github.com/example/example-nextjs-app.git",
      installCommand: "npm install",
      buildCommand: "npm run build",
      startCommand: "npm run start",
      packageManager: "NPM",
      runtime: "NODE",
      processManager: "PM2",
      healthStatus: "UNKNOWN"
    },
    create: {
      domainId: example.id,
      name: "Example Next.js App",
      slug: "example-nextjs-app",
      framework: "NEXTJS",
      runtime: "NODE",
      sourceProvider: "GITHUB",
      repoUrl: "https://github.com/example/example-nextjs-app",
      gitUrl: "https://github.com/example/example-nextjs-app.git",
      githubOwner: "example",
      githubRepo: "example-nextjs-app",
      branch: "main",
      commitSha: "seed-local-commit",
      rootDirectory: ".",
      rootPath: "D:/Projects/Cpanel/.local-www/example-nextjs-app",
      packageManager: "NPM",
      installCommand: "npm install",
      buildCommand: "npm run build",
      startCommand: "npm run start",
      outputDirectory: ".next",
      publicDirectory: "public",
      processManager: "PM2",
      status: "STOPPED",
      healthStatus: "UNKNOWN",
      port: 3001,
      envVars: {
        NODE_ENV: "production"
      },
      dbType: "POSTGRESQL",
      dbName: "proj_example_nextjs_app_db"
    }
  });

  const deployment = await prisma.deployment.findUniqueOrThrow({ where: { slug: "example-nextjs-app" } });

  await prisma.deploymentEnvVar.upsert({
    where: {
      deploymentId_key: {
        deploymentId: deployment.id,
        key: "NODE_ENV"
      }
    },
    update: { value: "production", isSecret: false },
    create: {
      deploymentId: deployment.id,
      key: "NODE_ENV",
      value: "production",
      isSecret: false
    }
  });

  const release = await prisma.deploymentRelease.upsert({
    where: { id: "seed-release-example-nextjs-app" },
    update: {
      deploymentId: deployment.id,
      status: "SUCCEEDED",
      commitSha: "seed-local-commit",
      commitMessage: "Seed deployment release",
      commitAuthor: "VPS Panel",
      sourcePath: deployment.rootPath,
      artifactPath: `${deployment.rootPath}/.next`,
      envSnapshot: {
        NODE_ENV: "production"
      },
      processConfig: {
        manager: "PM2",
        port: deployment.port
      },
      startedAt: new Date("2026-05-05T00:00:00.000Z"),
      finishedAt: new Date("2026-05-05T00:00:10.000Z"),
      durationMs: 10000
    },
    create: {
      id: "seed-release-example-nextjs-app",
      deploymentId: deployment.id,
      status: "SUCCEEDED",
      commitSha: "seed-local-commit",
      commitMessage: "Seed deployment release",
      commitAuthor: "VPS Panel",
      sourcePath: deployment.rootPath,
      artifactPath: `${deployment.rootPath}/.next`,
      envSnapshot: {
        NODE_ENV: "production"
      },
      processConfig: {
        manager: "PM2",
        port: deployment.port
      },
      startedAt: new Date("2026-05-05T00:00:00.000Z"),
      finishedAt: new Date("2026-05-05T00:00:10.000Z"),
      durationMs: 10000
    }
  });

  await prisma.deploymentLog.upsert({
    where: { id: "seed-log-example-nextjs-app-success" },
    update: {
      deploymentId: deployment.id,
      releaseId: release.id,
      step: "SUCCEEDED",
      level: "info",
      message: "Seed deployment release marked as successful",
      metadata: {
        dryRun: true
      }
    },
    create: {
      id: "seed-log-example-nextjs-app-success",
      deploymentId: deployment.id,
      releaseId: release.id,
      step: "SUCCEEDED",
      level: "info",
      message: "Seed deployment release marked as successful",
      metadata: {
        dryRun: true
      }
    }
  });

  await prisma.gitHubConnection.upsert({
    where: { id: "superadmin" },
    update: {},
    create: {
      id: "superadmin"
    }
  });

  await prisma.firewallRule.upsert({
    where: { id: "seed-http" },
    update: {},
    create: {
      id: "seed-http",
      port: 80,
      protocol: "tcp",
      action: "ALLOW",
      direction: "IN",
      note: "HTTP preset"
    }
  });

  await prisma.firewallRule.upsert({
    where: { id: "seed-ssh-limit" },
    update: {},
    create: {
      id: "seed-ssh-limit",
      port: 22,
      protocol: "tcp",
      action: "LIMIT",
      direction: "IN",
      note: "SSH rate limit preset"
    }
  });

  const firewallPresets = [
    { id: "seed-https", port: 443, protocol: "tcp", action: "ALLOW" as const, direction: "IN" as const, note: "HTTPS preset" },
    { id: "seed-smtp", port: 25, protocol: "tcp", action: "ALLOW" as const, direction: "IN" as const, note: "SMTP preset" },
    { id: "seed-submission", port: 587, protocol: "tcp", action: "ALLOW" as const, direction: "IN" as const, note: "SMTP submission preset" },
    { id: "seed-imaps", port: 993, protocol: "tcp", action: "ALLOW" as const, direction: "IN" as const, note: "IMAPS preset" },
    { id: "seed-dns-tcp", port: 53, protocol: "tcp", action: "ALLOW" as const, direction: "IN" as const, note: "DNS TCP preset" },
    { id: "seed-dns-udp", port: 53, protocol: "udp", action: "ALLOW" as const, direction: "IN" as const, note: "DNS UDP preset" }
  ];

  for (const preset of firewallPresets) {
    await prisma.firewallRule.upsert({
      where: { id: preset.id },
      update: {},
      create: preset
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
