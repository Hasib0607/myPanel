import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { MailQueueClient } from "./mail-queue-client";

export default function MailQueuePage() {
  return <AppShell><PageHeader title="Postfix Mail Queue" description="Inspect queued, deferred, and bounced deliveries; retry, flush, or delete messages." /><MailQueueClient /></AppShell>;
}
