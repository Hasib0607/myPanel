import { Worker } from "bullmq";
import { spawn } from "node:child_process";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";

function header(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function renderMessage(payload: { from: string; to: string; subject: string; html: string; text?: string }) {
  const text = payload.text || payload.html.replace(/<[^>]*>/g, " ");
  return [
    `From: ${header(payload.from)}`,
    `To: ${header(payload.to)}`,
    `Subject: ${header(payload.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text
  ].join("\n");
}

function sendmail(payload: { from: string; to: string; subject: string; html: string; text?: string }) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("sendmail", ["-f", payload.from, payload.to], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("sendmail timed out"));
    }, 30_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `sendmail exited with ${code}`));
    });
    child.stdin.end(renderMessage(payload));
  });
}

export const mailWorker = new Worker(
  "mail",
  async (job) => {
    if (job.name === "send") {
      const payload = job.data as { mailId: string; from: string; to: string; subject: string; html: string; text?: string };
      logger.info("mail send job accepted", {
        id: job.id,
        from: payload.from,
        to: payload.to,
        subject: payload.subject
      });

      try {
        await prisma.mail.update({
          where: { id: payload.mailId },
          data: { deliveryStatus: "PENDING", deliveryError: null }
        });
        await sendmail(payload);
        await prisma.mail.update({
          where: { id: payload.mailId },
          data: { deliveryStatus: "SENT", deliveryError: null, sentAt: new Date() }
        });
        return {
          dryRun: false,
          accepted: true,
          transport: "sendmail"
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        await prisma.mail.update({
          where: { id: payload.mailId },
          data: { deliveryStatus: finalAttempt ? "FAILED" : "PENDING", deliveryError: message }
        }).catch(() => undefined);
        logger.error("sendmail delivery failed", {
          id: job.id,
          error: message
        });
        throw error;
      }
    }

    logger.info("mail job received", { id: job.id, name: job.name });
    return { queued: true };
  },
  { connection: redis }
);
