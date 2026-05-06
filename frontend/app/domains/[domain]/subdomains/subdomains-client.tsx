"use client";

import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { apiGet, apiPost } from "@/lib/api";

type DomainDetail = {
  id: string;
  name: string;
  subdomains: Array<{ id: string; name: string; target: string; sslEnabled: boolean }>;
};

export function SubdomainsClient({ domainId }: { domainId: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const domain = useQuery({ queryKey: ["domain", domainId], queryFn: () => apiGet<DomainDetail>(`/domains/${domainId}`) });
  const create = useMutation({
    mutationFn: () => apiPost(`/domains/${domainId}/subdomains`, { name, target, sslEnabled: false }),
    onSuccess: async () => {
      setName("");
      setTarget("");
      await queryClient.invalidateQueries({ queryKey: ["domain", domainId] });
    }
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <>
      <PageHeader
        title={`${domain.data?.name ?? "Domain"} Subdomains`}
        description="Create subdomains, wildcard routes, SSL, and target mappings."
        action={
          <form className="flex gap-2" onSubmit={submit}>
            <input className="h-10 w-40 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setName(event.target.value)} placeholder="app" value={name} />
            <input className="h-10 w-56 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setTarget(event.target.value)} placeholder="127.0.0.1 or cname" value={target} />
            <button className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white" disabled={!name || !target} type="submit"><Plus size={16} /> Add</button>
          </form>
        }
      />
      <section className="p-8">
        <div className="rounded-md border border-panel-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-panel-muted">
              <tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Target</th><th className="px-4 py-3">SSL</th></tr>
            </thead>
            <tbody>
              {(domain.data?.subdomains ?? []).map((subdomain) => (
                <tr key={subdomain.id} className="border-t border-panel-line">
                  <td className="px-4 py-3 font-medium">{subdomain.name}.{domain.data?.name}</td>
                  <td className="px-4 py-3">{subdomain.target}</td>
                  <td className="px-4 py-3">{subdomain.sslEnabled ? "enabled" : "pending"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
