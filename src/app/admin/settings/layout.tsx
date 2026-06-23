"use client";

import { useRouter } from "next/navigation";
import { AdminPageShell } from "@/components/admin-page-shell";
import { getSettingsReturn } from "@/lib/settings-return";

export default function AdminSettingsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  return (
    <AdminPageShell
      title="Settings"
      description="Video pipeline settings and your API keys."
      onBack={() => router.push(getSettingsReturn())}
      backLabel="Back"
      maxWidth="max-w-3xl"
    >
      {children}
    </AdminPageShell>
  );
}
