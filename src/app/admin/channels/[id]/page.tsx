"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, Loader2, Save, Sliders } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ErrorAlert } from "@/components/ui/error-alert";
import { useActiveChannel } from "@/lib/active-channel-context";
import { PageContainer } from "@/components/ui/page-container";

type Form = {
  name: string;
  handle: string;
  video_style: string;
  voice_id: string;
  voice_speed: string;
  voice_stability: string;
  voice_similarity_boost: string;
  voice_style: string;
  stock_folder: string;
};

const VOICE_DEFAULTS = {
  voice_speed: "0.85",
  voice_stability: "0.6",
  voice_similarity_boost: "0.75",
  voice_style: "0.15",
} as const;

function fieldNumber(value: unknown, fallback: string): string {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? String(n) : fallback;
}

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
  const [voiceOpen, setVoiceOpen] = useState(false);

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
        voice_id: c.voice_id ?? "",
        voice_speed: fieldNumber(c.voice_speed, VOICE_DEFAULTS.voice_speed),
        voice_stability: fieldNumber(c.voice_stability, VOICE_DEFAULTS.voice_stability),
        voice_similarity_boost: fieldNumber(c.voice_similarity_boost, VOICE_DEFAULTS.voice_similarity_boost),
        voice_style: fieldNumber(c.voice_style, VOICE_DEFAULTS.voice_style),
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
    <PageContainer className="max-w-2xl space-y-5">
      <div className="space-y-4">
        <Link href="/admin/channels" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <ArrowLeft className="h-4 w-4" />
          Go back
        </Link>
        <h1 className="text-[19px] font-semibold leading-tight tracking-normal text-foreground">
          Channel settings
        </h1>
      </div>

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
            <Field label="B-Roll folder">
              <Input
                value={form.stock_folder}
                onChange={(e) => set("stock_folder", e.target.value)}
                placeholder={form.name}
              />
            </Field>
          </div>

          <Field label="Video style">
            <Textarea
              value={form.video_style}
              onChange={(e) => set("video_style", e.target.value)}
              rows={4}
              placeholder="e.g. Slow cinematic documentary motion, muted earth tones, soft contrast, dreamlike pacing…"
            />
          </Field>

          <div className="rounded-lg border border-border bg-card">
            <button
              type="button"
              onClick={() => setVoiceOpen((open) => !open)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
            >
              <span className="inline-flex items-center gap-2 text-sm font-semibold">
                <Sliders className="h-4 w-4 text-muted-foreground" />
                Voice settings
              </span>
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition ${voiceOpen ? "rotate-180" : ""}`} />
            </button>
            {voiceOpen && (
              <div className="space-y-4 border-t border-border p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Provider">
                    <div className="flex h-10 items-center rounded-md border border-input bg-muted/35 px-3 text-sm">
                      ElevenLabs
                    </div>
                  </Field>
                  <Field label="Voice ID">
                    <Input
                      value={form.voice_id}
                      onChange={(e) => set("voice_id", e.target.value)}
                      placeholder="Leave blank for default"
                    />
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <VoiceSlider
                    label="Speed"
                    value={form.voice_speed}
                    min={0.7}
                    max={1.2}
                    step={0.01}
                    onChange={(value) => set("voice_speed", value)}
                  />
                  <VoiceSlider
                    label="Stability"
                    value={form.voice_stability}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(value) => set("voice_stability", value)}
                  />
                  <VoiceSlider
                    label="Similarity boost"
                    value={form.voice_similarity_boost}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(value) => set("voice_similarity_boost", value)}
                  />
                  <VoiceSlider
                    label="Style"
                    value={form.voice_style}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(value) => set("voice_style", value)}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
            {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved</span>}
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </Button>
          </div>
        </div>
      )}
    </PageContainer>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function VoiceSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: string) => void;
}) {
  const numericValue = fieldNumber(value, String(min));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs">{label}</Label>
        <span className="rounded-md bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
          {Number(numericValue).toFixed(2)}
        </span>
      </div>
      <Input
        type="range"
        min={min}
        max={max}
        step={step}
        value={numericValue}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 cursor-pointer"
      />
    </div>
  );
}
