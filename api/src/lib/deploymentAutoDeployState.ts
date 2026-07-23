export function deploymentNeedsRecoveryDeploy(deployment: { status: string; healthStatus?: string | null }) {
  return (deployment.status === "FAILED" && ["DOWN", "UNKNOWN", null, undefined].includes(deployment.healthStatus))
    || (deployment.status === "RUNNING" && deployment.healthStatus === "DOWN");
}
