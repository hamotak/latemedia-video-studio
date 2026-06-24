"use client";

import { use, useCallback, useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { AdminPageShell } from "@/components/admin-page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ErrorAlert } from "@/components/ui/error-alert";
import { useActiveChannel } from "@/lib/active-channel-context";

type Form = {
  name: string;
  handle: string;
  video_style: string;
  voice_provider: string;
  voice_id: string;
  stock_folder: string;
};

/**
 * Channel "video profile" editor. Sets the voice + visual style the Video
 * studio renders this channel against. Saves via PATCH /api/studio/channels/[id],
 * which syncs these fields onto the engine render preset.
 */
export default function ChannelEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { refresh } = useActiveChannel();
  const [form, setForm] = useState<Form | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/studio/channels/${id}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not load channel.");
      const c = data.channel ?? {};
      setForm({
        name: c.name ?? "",
        handle: c.handle ?? "",
        video_style:
          typeof c.video_style === "string"
            ? c.video_style
            : c.video_style
            ? JSON.stringify(c.video_style)
            : "",
        voice_provider: c.voice_provider ?? "elevenlabs",
        voice_id: c.voice_id ?? "",
        stock_folder: c.stock_folder ?? "",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load channel.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (k: keyof Form, v: string) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const res = await fetch(`/api/studio/channels/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not save channel.");
      setSaved(true);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save channel.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminPageShell
      title="Channel settings"
      description="The voice and visual style used when this channel renders videos."
      backHref="/admin/channels"
      backLabel="Channels"
      maxWidth="max-w-2xl"
    >
      {loading || !form ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-5">
          {error && <ErrorAlert message={error} />}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Channel name">
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="Handle">
              <Input value={form.handle} onChange={(e) => set("handle", e.target.value)} placeholder="@handle" />
            </Field>
          </div>

          <Field
            label="Video style"
            hint="Describes the look & mood applied to every scene. Leave blank to use the global default."
          >
            <Textarea
              value={form.video_style}
              onChange={(e) => set("video_style", e.target.value)}
              rows={4}
              placeholder="e.g. Slow cinematic documentary motion, muted earth tones, soft contrast, dreamlike pacing…"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Voice provider" hint="elevenlabs or voice-clone">
              <Input
                value={form.voice_provider}
                onChange={(e) => set("voice_provider", e.target.value)}
                placeholder="elevenlabs"
              />
            </Field>
            <Field label="Voice ID" hint="The TTS voice for this channel.">
              <Input
                value={form.voice_id}
                onChange={(e) => set("voice_id", e.target.value)}
                placeholder="Leave blank for default"
              />
            </Field>
          </div>

          <Field label="B-Roll folder" hint="Name of this channel's B-Roll subfolder.">
            <Input
              value={form.stock_folder}
              onChange={(e) => set("stock_folder", e.target.value)}
              placeholder={form.name}
            />
          </Field>

          <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
            {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved</span>}
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </Button>
          </div>
        </div>
      )}
    </AdminPageShell>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
