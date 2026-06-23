import { getSetting } from "../settings";
import { log } from "../logger";

/**
 * Visual Director — the cohesion brain for Image Cut mode.
 *
 * Per-chunk image prompts generated in isolation drift: a video about tunnels
 * that briefly mentions a castle gets one tunnel image then one unrelated castle
 * image. This reads the WHOLE script first, commits to ONE visual world (subject,
 * palette, lighting, mood) consistent with the channel style, then writes each
 * chunk's image prompt to live inside that world — bridging topic jumps instead
 * of hard-cutting (tunnels + castle -> "the tunnels beneath the castle").
 */

export interface VisualPlanChunk {
  index: number;
  text: string;
}

export interface VisualPlanInput {
  fullScript: string;
  chunks: VisualPlanChunk[];
  channelStyle?: string | null;
  channelName?: string | null;
  channelDescription?: string | null;
  title?: string | null;
}

export interface VisualPlanResult {
  /** One-line description of the chosen visual throughline (for logs). */
  concept: string;
  /** chunk index -> coherent image prompt. Missing indices fall back upstream. */
  prompts: Record<number, string>;
}

const SYSTEM_PROMPT = [
  "You are the Visual Director for an AI documentary-video generator for a faceless YouTube channel.",
  "You receive the FULL narration script and an ordered list of timed scenes. Some scenes become short AI video clips and some become still-image Ken Burns shots.",
  "",
  "Your job is COHESION. Before writing any prompt:",
  "1. Decide ONE visual bible for the entire video — anchor subject, era, setting logic, palette, lighting, lens, mood, recurring motifs, and forbidden drift.",
  "2. Keep it faithful to the channel's subject and style. If the channel is ancient pirates, keep government/trade/war ideas visually inside the pirate-era world. If the channel is deep ocean, keep every abstract idea visually inside the marine abyss.",
  "3. Prefer ancient, timeless, non-modern imagery unless the script explicitly requires modern technology.",
  "",
  "Then write each scene's visual_prompt so it lives INSIDE that one world:",
  "- Reflect that chunk's specific content, but never abandon the established look.",
  "- BRIDGE topic jumps. If a pirate video mentions government, show an old harbor office, naval papers, a governor's seal, or officials seen through a pirate-era maritime world — not a standalone modern government scene.",
  "- If a marine/deep-ocean video mentions calm, waiting, silence, or time, show abyssal ridges, marine snow, bioluminescent life, pressure, black water, or seafloor details — not jungle animals, modern ships, or unrelated land scenes.",
  "- Keep palette, lighting, and mood continuous from the previous chunk.",
  "- Vary neighboring shots: alternate wide, medium, detail, over-shoulder, object insert, and environmental shots so adjacent scenes do not repeat the same composition.",
  "- One cinematic shot per prompt: a single full-frame continuous image, one camera, one scene.",
  "- Absolutely no collage, panels, grids, split-screen, diptych, triptych, contact sheet, picture-in-picture, multiple photos, borders, letterboxing, pillarboxing, black bars, on-image text, captions, subtitles, logos, watermarks, or UI.",
  "",
  'Return ONLY JSON in this shape: { "concept": "<one sentence visual bible>", "prompts": [{ "index": <number>, "visual_prompt": "<one vivid cinematic shot, 1-2 sentences>" }] }. Include every chunk index you were given. No prose outside the JSON.',
].join("\n");

const IMAGE_CUT_FRAME_SAFETY =
  "Single full-frame cinematic image, one continuous shot, one camera, one scene. No collage, no panels, no grid, no split-screen, no diptych, no triptych, no contact sheet, no picture-in-picture, no multiple photos, no borders, no letterboxing, no pillarboxing, no black bars, no text, no captions, no subtitles, no logos, no watermarks, no UI.";

export function sanitizeImageCutPrompt(prompt: string): string {
  const clean = prompt.replace(/\s+/g, " ").trim();
  if (!clean) return IMAGE_CUT_FRAME_SAFETY;
  if (clean.toLowerCase().includes("no collage") && clean.toLowerCase().includes("single full-frame")) {
    return clean;
  }
  return `${clean} ${IMAGE_CUT_FRAME_SAFETY}`;
}

export async function planVisualThroughline(
  runId: string,
  input: VisualPlanInput
): Promise<VisualPlanResult> {
  const empty: VisualPlanResult = { concept: "", prompts: {} };
  if (input.chunks.length === 0) return empty;

  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) {
    log(runId, "warn", "Visual Director skipped: GOOGLE_API_KEY not set — using per-chunk prompts.", { stage: "image" });
    return empty;
  }
  const model = getSetting("IMAGE_CUT_VISUAL_MODEL") || "gemini-2.5-pro";

  const userMessage = [
    input.title ? `VIDEO TITLE: ${input.title}` : "",
    input.channelName?.trim() ? `CHANNEL NAME:\n${input.channelName.trim()}` : "",
    input.channelDescription?.trim() ? `CHANNEL DESCRIPTION:\n${input.channelDescription.trim()}` : "",
    input.channelStyle?.trim() ? `CHANNEL VISUAL STYLE (obey this):\n${input.channelStyle.trim()}` : "",
    `FULL SCRIPT (for context — establish the single visual world from this):\n${input.fullScript.trim()}`,
    "CHUNKS TO ILLUSTRATE (write one coherent visual_prompt for each, in order):",
    JSON.stringify(input.chunks.map((c) => ({ index: c.index, text: c.text })), null, 0),
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    log(runId, "info", `Visual Director planning ${input.chunks.length} coherent scenes (${model})`, { stage: "image" });
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.45,
            maxOutputTokens: 20000,
            thinkingConfig: { thinkingBudget: 1024 },
          },
        }),
      }
    );
    if (!resp.ok) {
      throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    }
    const json = (await resp.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };
    const cand = json.candidates?.[0];
    if (cand?.finishReason && cand.finishReason !== "STOP") {
      throw new Error(`Gemini finish=${cand.finishReason}`);
    }
    const raw = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!raw.trim()) throw new Error("Gemini returned empty visual plan");

    const parsed = extractJson(raw);
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)?.prompts)
        ? ((parsed as Record<string, unknown>).prompts as unknown[])
        : [];
    const concept = Array.isArray(parsed)
      ? ""
      : String((parsed as Record<string, unknown>)?.concept ?? "").trim();
    const prompts: Record<number, string> = {};
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const idx = Number((item as Record<string, unknown>).index);
      const prompt = String((item as Record<string, unknown>).visual_prompt ?? "").trim();
      if (Number.isInteger(idx) && prompt) prompts[idx] = prompt;
    }
    const covered = input.chunks.filter((c) => prompts[c.index]).length;
    log(runId, "success", `Visual Director set ${covered}/${input.chunks.length} coherent prompts${concept ? ` · ${concept.slice(0, 120)}` : ""}`, {
      stage: "image",
    });
    return { concept, prompts };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(runId, "warn", `Visual Director failed (${msg.slice(0, 160)}) — falling back to per-chunk prompts.`, { stage: "image" });
    return empty;
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const match = trimmed.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }
  return {};
}
