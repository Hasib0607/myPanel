import { z } from "zod";

const configuredWorkerMax = Number(process.env.DEPLOYMENT_WORKER_MAX ?? 3);
export const deploymentWorkerMax = Math.max(1, Math.min(64, Number.isFinite(configuredWorkerMax) ? configuredWorkerMax : 3));

export const laravelProcessSchema = z.object({
  enabled: z.boolean().default(false),
  command: z.string().trim().min(1).max(500),
  instances: z.number().int().min(1).max(deploymentWorkerMax).default(1)
});

export const laravelQueueGroupSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9-]+$/).max(50),
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  autoscale: z.boolean().default(false),
  desiredWorkers: z.number().int().min(0).max(deploymentWorkerMax).default(1),
  minWorkers: z.number().int().min(0).max(deploymentWorkerMax).default(0),
  maxWorkers: z.number().int().min(1).max(deploymentWorkerMax).default(deploymentWorkerMax),
  queueNames: z.array(z.string().trim().min(1).max(100)).min(1).default(["default"]),
  command: z.string().trim().min(1).max(500).optional()
}).transform((value) => ({
  ...value,
  maxWorkers: Math.min(deploymentWorkerMax, Math.max(value.maxWorkers, value.minWorkers, value.desiredWorkers)),
  desiredWorkers: value.enabled ? Math.max(value.minWorkers, Math.min(value.desiredWorkers, Math.max(value.maxWorkers, value.minWorkers, deploymentWorkerMax))) : 0
}));

export const laravelManagedProcessesSchema = z.object({
  scheduler: laravelProcessSchema.default({ enabled: false, command: "php artisan schedule:work", instances: 1 }),
  horizon: laravelProcessSchema.default({ enabled: false, command: "php artisan horizon", instances: 1 }),
  reverb: laravelProcessSchema.default({ enabled: false, command: "php artisan reverb:start --host=127.0.0.1", instances: 1 }),
  octane: laravelProcessSchema.default({ enabled: false, command: "php artisan octane:start --server=swoole --host=127.0.0.1 --port={PORT}", instances: 1 }),
  queueGroups: z.array(laravelQueueGroupSchema).max(20).default([])
});

export type LaravelManagedProcesses = z.infer<typeof laravelManagedProcessesSchema>;
export type LaravelQueueGroup = z.infer<typeof laravelQueueGroupSchema>;

export function normalizeLaravelManagedProcesses(input: unknown): LaravelManagedProcesses {
  return laravelManagedProcessesSchema.parse(input && typeof input === "object" ? input : {});
}

export function renderLaravelProcessCommand(command: string, port: number) {
  return command.replaceAll("{PORT}", String(port));
}

export function queueGroupCommand(group: LaravelQueueGroup) {
  return group.command?.trim()
    || `php artisan queue:work --queue=${group.queueNames.join(",")} --sleep=3 --tries=3 --timeout=90`;
}

export function laravelManagedProgramName(slug: string, kind: string) {
  return `${slug}-${kind.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}`;
}

export function inferredLaravelManagedProcesses(envVars: Record<string, string>, current: unknown): LaravelManagedProcesses {
  const config = normalizeLaravelManagedProcesses(current);
  const octaneServer = (envVars.OCTANE_SERVER || "").trim().toLowerCase();
  const enabled = (value: string | undefined) => ["1", "true", "yes", "on"].includes((value || "").trim().toLowerCase());
  const reverbConfigured = Boolean(envVars.REVERB_APP_ID || envVars.REVERB_HOST || (envVars.BROADCAST_CONNECTION || "").toLowerCase() === "reverb");
  return {
    ...config,
    scheduler: { ...config.scheduler, enabled: config.scheduler.enabled || enabled(envVars.SCHEDULER_ENABLED) },
    horizon: { ...config.horizon, enabled: config.horizon.enabled || enabled(envVars.HORIZON_ENABLED) },
    octane: {
      ...config.octane,
      enabled: config.octane.enabled || ["swoole", "openswoole"].includes(octaneServer),
      command: config.octane.command.replace("--server=swoole", `--server=${octaneServer || "swoole"}`)
    },
    reverb: { ...config.reverb, enabled: config.reverb.enabled || reverbConfigured }
  };
}
