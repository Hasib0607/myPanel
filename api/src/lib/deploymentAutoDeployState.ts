export function deploymentNeedsRecoveryDeploy(deployment: { status: string; healthStatus?: string | null }) {
  return deployment.status === "FAILED" || (deployment.status === "RUNNING" && deployment.healthStatus === "DOWN");
}
