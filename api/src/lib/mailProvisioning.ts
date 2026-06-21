export type MailProvisioningResult = {
  ok?: boolean;
  dryRun?: boolean;
  error?: string;
};

export function assertLiveMailProvisioning(result: unknown, action: string) {
  const value = result as MailProvisioningResult | null;
  if (!value || value.ok !== true || value.dryRun === true) {
    const detail = value?.error ? `: ${value.error}` : "";
    throw Object.assign(new Error(`${action} was not applied to the mail server${detail}`), { statusCode: 503 });
  }
  return result;
}
