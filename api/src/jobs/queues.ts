import { Queue } from "bullmq";
import { redis } from "../lib/redis.js";

export const mailQueue = new Queue("mail", { connection: redis });
export const deployQueue = new Queue("deploy", { connection: redis });
export const sslQueue = new Queue("ssl", { connection: redis });
export const guardianQueue = new Queue("guardian", { connection: redis });
