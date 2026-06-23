"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Clapperboard, HardDrive, Loader2, PlugZap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchJson } from "@/lib/client-fetch";
import { cn } from "@/lib/utils";

/**
 * Video pipeline render settings. Provider API keys live in the global
 * Integrations cards above; this section keeps only non-secret model,
 * provider, path, and render knobs.
 */
const RENDER_FIELDS: { key: string; label: string }[] = [
  { key: "SCENE_SPLIT_PROVIDER", label: "Scene split provider" },
  { key: "SCENE_SPLIT_MODEL", label: "Scene split model" },
  { key: "IMAGE_PROVIDER", label: "Image provider" },
  { key: "IMAGE_MODEL", label: "Image model" },
  { key: "IMAGE_RATIO", label: "Image ratio" },
  { key: "ANIMATION_PROVIDER", label: "Animation provider" },
  { key: "ANIMATION_MODEL", label: "Animation model" },
  { key: "VIDEO_RESOLUTION", label: "Video resolution" },
  { key: "VIDEO_FPS", label: "Video FPS" },
  { key: "FFMPEG_PATH", label: "FFmpeg path" },
  { key: "RUNS_OUTPUT_DIR", label: "Renders temp folder" },
];

const DRIVE_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "GDRIVE_CLIENT_ID", label: "Google OAuth client ID" },
  { key: "GDRIVE_CLIENT_SECRET", label: "Google OAuth client secret" },
  { key: "GDRIVE_SYNC_ENABLED", label: "Sync finished renders to Drive", hint: "Use 1 for on, 0 for off." },
];

export function VideoPipelineSettings() {
  const [masked, setMasked] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [driveNotice, setDriveNotice] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const [redirectUri, setRedirectUri] = useState("/api/gdrive/oauth/callback");

  useEffect(() => {
    setRedirectUri(`${window.location.origin}/api/gdrive/oauth/callback`);
    const params = new URLSearchParams(window.location.search);
    const drive = params.get("drive");
    const driveError = params.get("driveError");
    if (drive === "connected") {
      setDriveNotice({ kind: "success", message: "Google Drive connected." });
    } else if (drive === "admin-required") {
      setDriveNotice({ kind: "error", message: "Only admins can connect Google Drive." });
    } else if (drive === "setup-required") {
      setDriveNotice({
        kind: "error",
        message: driveError || "Google Drive OAuth is not configured yet.",
      });
    } else if (drive === "error") {
      setDriveNotice({
        kind: "error",
        message: driveError || "Google Drive connection failed.",
      });
    }
  }, []);

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
      setError(err instanceof Error ? err.message : "Could not load video settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

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
      setError(err instanceof Error ? err.message : "Could not save video settings.");
    } finally {
      setSaving(false);
    }
  };

  // Non-admins (403) don't get this section at all.
  if (!allowed) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Clapperboard className="h-3.5 w-3.5" />
          </span>
          <div>
            <CardTitle>Video pipeline</CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
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
            <SettingsFieldGrid fields={RENDER_FIELDS} masked={masked} edits={edits} onChange={setEdits} />

            <div className="rounded-lg border border-border bg-background/50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <HardDrive className="h-3.5 w-3.5" />
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold">Google Drive sync</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Saves final videos and reusable clips into Drive. Add the OAuth client credentials, then connect.
                    </p>
                  </div>
                </div>
                <a
                  href="/api/gdrive/oauth/start?returnTo=/admin/settings/video"
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    (!masked.GDRIVE_CLIENT_ID || !masked.GDRIVE_CLIENT_SECRET) && "pointer-events-none opacity-50"
                  )}
                  aria-disabled={!masked.GDRIVE_CLIENT_ID || !masked.GDRIVE_CLIENT_SECRET}
                >
                  <PlugZap className="h-3.5 w-3.5" />
                  {masked.GDRIVE_CONNECTED_EMAIL ? "Reconnect Drive" : "Connect Drive"}
                </a>
              </div>

              <div className="mt-4 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Google Cloud redirect URI: <span className="font-mono text-foreground">{redirectUri}</span>
              </div>

              {driveNotice && (
                <div
                  className={cn(
                    "mt-3 rounded-md border px-3 py-2 text-xs",
                    driveNotice.kind === "success"
                      ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                      : "border-destructive/30 bg-destructive/10 text-destructive"
                  )}
                >
                  {driveNotice.message}
                </div>
              )}

              {masked.GDRIVE_CONNECTED_EMAIL && (
                <div className="mt-3 rounded-md border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
                  Connected as {masked.GDRIVE_CONNECTED_EMAIL}
                </div>
              )}

              <div className="mt-4">
                <SettingsFieldGrid fields={DRIVE_FIELDS} masked={masked} edits={edits} onChange={setEdits} />
              </div>
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
}: {
  fields: { key: string; label: string; hint?: string }[];
  masked: Record<string, string>;
  edits: Record<string, string>;
  onChange: React.Dispatch<React.SetStateAction<Record<string, string>>>;
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
              type="text"
              value={edits[f.key] ?? ""}
              onChange={(e) => onChange((p) => ({ ...p, [f.key]: e.target.value }))}
              placeholder={current}
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
