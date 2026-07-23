import { runDomainHostSync } from "../lib/domainHostSync.js";
import { redis } from "../lib/redis.js";

const result = await runDomainHostSync({ includeDns: true, queueRepair: true });
console.log(JSON.stringify(result, null, 2));
await redis.quit();
