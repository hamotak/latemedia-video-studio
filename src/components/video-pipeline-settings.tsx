"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, FolderOpen, KeyRound, Loader2, Sliders } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchJson } from "@/lib/client-fetch";

/**
 * Video pipeline settings for the standalone app.
 *
 * The only things a user needs: paste their API keys, and (optionally) tweak a
 * couple of render knobs. Everything else — scene-split model, image model,
 * animation model — stays at the proven defaults from
 * `video-engine/settings.ts` and is intentionally not exposed.
 */
const API_KEY_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "LABS69_API_KEY", label: "69labs API key", hint: "Required — video, voiceover & images." },
  { key: "GOOGLE_API_KEY", label: "Google Gemini API key", hint: "Required — scene splitting & visual prompts." },
];

const ADVANCED_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "VIDEO_RESOLUTION", label: "Video resolution", hint: "e.g. 1920x1080" },
  { key: "VIDEO_FPS", label: "Video FPS", hint: "24, 30 or 60" },
  { key: "FFMPEG_PATH", label: "FFmpeg path", hint: "Leave blank — FFmpeg is bundled." },
];

export function VideoPipelineSettings() {
  const [masked, setMasked] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/video/settings", { cache: "no-store" });
      if (res.status === 403) {
        setAllowed(false);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setMasked(data.settings ?? {});
      setEdits({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      // Only send fields the user actually typed into.
      const settings = Object.fromEntries(
        Object.entries(edits).filter(([, v]) => v.trim() !== "")
      );
      await fetchJson("/api/video/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      setSaved(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save settings.");
    } finally {
      setSaving(false);
    }
  };

  // Non-admins (403) don't get this section at all.
  if (!allowed) return null;

  const outputDir = masked.LOCAL_LIBRARY_DIR || "Desktop → Late Media Videos";

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <KeyRound className="h-3.5 w-3.5" />
          </span>
          <div>
            <CardTitle>API keys & video settings</CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-0">
        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {error && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <div className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold">API keys</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Paste your keys below — they are stored only on this computer. A saved key shows as
                  dots; type a new value to replace it.
                </p>
              </div>
              <SettingsFieldGrid fields={API_KEY_FIELDS} masked={masked} edits={edits} onChange={setEdits} secret />
            </div>

            <div className="flex items-start gap-2.5 rounded-lg border border-border bg-background/50 p-3">
              <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                Finished videos and B-Rolls are saved locally to{" "}
                <span className="font-medium text-foreground">{outputDir}</span>.
              </p>
            </div>

            <div className="rounded-lg border border-border bg-background/50">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <Sliders className="h-3.5 w-3.5" />
                Advanced (optional)
              </button>
              {showAdvanced && (
                <div className="border-t border-border p-4">
                  <SettingsFieldGrid fields={ADVANCED_FIELDS} masked={masked} edits={edits} onChange={setEdits} />
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
              {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved</span>}
              <Button onClick={save} disabled={saving || Object.keys(edits).length === 0} size="sm">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Save changes
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SettingsFieldGrid({
  fields,
  masked,
  edits,
  onChange,
  secret,
}: {
  fields: { key: string; label: string; hint?: string }[];
  masked: Record<string, string>;
  edits: Record<string, string>;
  onChange: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  secret?: boolean;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map((f) => {
        const current = masked[f.key] ?? "";
        return (
          <div key={f.key} className="space-y-1.5">
            <Label htmlFor={`video-${f.key}`} className="text-xs">{f.label}</Label>
            <Input
              id={`video-${f.key}`}
              type={secret ? "password" : "text"}
              value={edits[f.key] ?? ""}
              onChange={(e) => onChange((p) => ({ ...p, [f.key]: e.target.value }))}
              placeholder={current || (secret ? "Paste key…" : "")}
              className="h-9 text-sm"
              autoComplete="off"
            />
            {f.hint && <p className="text-[11px] text-muted-foreground">{f.hint}</p>}
          </div>
        );
      })}
    </div>
  );
}
