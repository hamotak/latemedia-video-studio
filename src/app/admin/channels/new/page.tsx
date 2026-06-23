"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { AdminPageShell } from "@/components/admin-page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorAlert } from "@/components/ui/error-alert";
import { useActiveChannel } from "@/lib/active-channel-context";

/**
 * Simple, offline channel creation. A channel just needs a name; its voice and
 * visual style are tuned later in Settings / per render. No YouTube account or
 * API key is required to create one.
 */
export default function NewChannelPage() {
  const router = useRouter();
  const { switchChannel, refresh } = useActiveChannel();
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    if (!name.trim()) {
      setError("Please enter a channel name.");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/studio/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), handle: handle.trim() || null }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        channel?: { id: number };
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Could not create channel.");
      await refresh();
      if (data.channel?.id) await switchChannel(data.channel.id);
      router.push("/studio/video");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create channel.");
      setCreating(false);
    }
  };

  return (
    <AdminPageShell
      title="Add channel"
      description="Create a channel to render videos against. You can fine-tune its voice and visual style later in Settings."
      backHref="/admin"
      backLabel="Dashboard"
      maxWidth="max-w-lg"
    >
      <div className="mx-auto max-w-lg space-y-5">
        {error && <ErrorAlert message={error} />}
        <div className="space-y-2">
          <Label htmlFor="ch-name">Channel name</Label>
          <Input
            id="ch-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Earth Radar"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ch-handle">Handle (optional)</Label>
          <Input
            id="ch-handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="@earthradar"
          />
        </div>
        <Button onClick={() => void create()} disabled={creating || !name.trim()} className="w-full">
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Create channel
        </Button>
      </div>
    </AdminPageShell>
  );
}
