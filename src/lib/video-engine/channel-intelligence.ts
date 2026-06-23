import { DEFAULT_STYLE_PRESET_ID, STYLE_PRESETS, loadStylePreset } from "./style-presets";

export interface ChannelIdeaInput {
  name: string;
  description?: string | null;
  stylePresetId?: string | null;
  videoStyle?: string | null;
}

export interface ChannelInference {
  domainId: string;
  domainLabel: string;
  confidence: number;
  stylePresetId: string;
  stockFolder: string;
  videoModel: string;
  aspectRatio: string;
  videoStyle: string;
  visualDoctrine: string;
}

interface DomainProfile {
  id: string;
  label: string;
  folder: string;
  keywords: string[];
  visualWorld: string;
  allowed: string;
  bridge: string;
  avoid: string;
}

const TEXT_MATCH_RULE =
  "Narration-match rule: every image prompt must visibly match the exact scene text first: keep named places, eras, animals, vehicles, objects, actions, scale, and mood. If the narration is abstract, translate it through this channel world instead of switching to unrelated imagery.";

const PROFILES: DomainProfile[] = [
  {
    id: "deep-sea",
    label: "Deep Sea / Marine Documentary",
    folder: "Deep-Sea",
    keywords: [
      "deep sea",
      "deep ocean",
      "marine",
      "ocean",
      "underwater",
      "abyss",
      "abyssal",
      "cold depths",
      "sea life",
      "seafloor",
      "hydrothermal",
      "submersible",
      "rov",
      "coral",
      "whale",
      "shark",
      "squid",
      "jellyfish",
      "bioluminescent",
    ],
    visualWorld:
      "Deep-ocean and marine-science documentary world: black water, abyssal plains, seafloor geology, marine snow, drifting particles, bioluminescent life, hydrothermal vents, reefs or kelp forests only when the text fits, and research submersibles or ROVs only when exploration technology is relevant.",
    allowed:
      "Use real marine animals, underwater habitats, pressure, currents, sonar-like distance, cold blue-black water, soft shafts of light in shallow scenes, macro biological detail, and patient natural-history camera language.",
    bridge:
      "For ideas like silence, time, danger, patience, or mystery, show abyssal darkness, slow currents, drifting marine snow, distant silhouettes, pressure, or seafloor features.",
    avoid:
      "Avoid land animals, forests, deserts, generic beaches, random boats, city scenes, fantasy sea monsters, aquarium/tank staging, cartoon style, and unrelated human drama.",
  },
  {
    id: "pirate-history",
    label: "Pirate / Maritime History",
    folder: "Pirates",
    keywords: [
      "pirate",
      "piracy",
      "privateer",
      "corsair",
      "frigate",
      "sloop",
      "galleon",
      "caribbean",
      "jamaica",
      "jamaican",
      "blackbeard",
      "golden age",
      "naval",
      "warship",
      "merchant ship",
      "gun ports",
      "harbor",
    ],
    visualWorld:
      "17th-18th century pirate-era maritime history world: weathered wooden sloops, frigates, gun decks, gun ports, rope rigging, torn canvas, salt-stained decks, coastal harbors, Caribbean or Atlantic horizons, naval papers, taverns, docks, and sailors in period clothing.",
    allowed:
      "Use shipboard viewpoints, over-shoulder lookouts, deck details, cannon hardware, charts, spyglasses, harbor offices, coastlines, and distant sails.",
    bridge:
      "For government, money, fear, law, or empire, stay inside the maritime world: old harbor offices, naval seals, ledgers, dockside officials, colonial forts, maps, or shipboard reactions.",
    avoid:
      "Avoid modern coastlines, roads, cars, modern buildings, tourist clothing, generic lone travelers, unrelated rocky shores, fantasy armor, and medieval castles unless the text explicitly requires them.",
  },
  {
    id: "space",
    label: "Space / Astronomy Documentary",
    folder: "Space",
    keywords: [
      "space",
      "astronomy",
      "cosmos",
      "universe",
      "planet",
      "star",
      "galaxy",
      "nebula",
      "orbit",
      "solar",
      "black hole",
      "moon",
      "mars",
      "comet",
      "asteroid",
    ],
    visualWorld:
      "Astronomy documentary world: planets, star fields, nebulae, orbital mechanics, spacecraft silhouettes when relevant, observatories, cosmic scale, dark skies, and physically plausible celestial scenes.",
    allowed:
      "Use real astronomical forms, telescope/observatory details, orbital diagrams translated into cinematic space views, dust, plasma, ice, rock, sunlight, eclipse shadows, and quiet scale.",
    bridge:
      "For time, gravity, distance, or danger, show orbital paths, shadow, stellar light, cosmic dust, gravitational scale, or observatory instruments.",
    avoid:
      "Avoid fantasy planets, sci-fi cities, spacesuit close-ups without reason, cartoon stars, neon game art, unrelated landscapes, and impossible colorful clutter.",
  },
  {
    id: "earth-nature",
    label: "Earth / Nature Documentary",
    folder: "Nature",
    keywords: [
      "earth",
      "nature",
      "wildlife",
      "animal",
      "forest",
      "jungle",
      "mountain",
      "river",
      "weather",
      "volcano",
      "desert",
      "island",
      "ecosystem",
      "planet earth",
    ],
    visualWorld:
      "Natural-history documentary world: real ecosystems, wildlife behavior, landscapes, geology, weather, plants, water, and atmospheric light tied directly to the narration.",
    allowed:
      "Use real species, habitat-specific geography, natural motion, patient telephoto or macro details, wide establishing shots, and environmental cause-and-effect.",
    bridge:
      "For abstract ideas, show ecological relationships, weather, seasonal change, tracks, water movement, geological scale, or animal behavior that embodies the idea.",
    avoid:
      "Avoid studio staging, fantasy creatures, generic stock landscapes that ignore the text, city scenes, unrelated species, and cartoon/painterly looks.",
  },
  {
    id: "ancient-history",
    label: "Ancient / Historical Documentary",
    folder: "History",
    keywords: [
      "ancient",
      "history",
      "roman",
      "rome",
      "egypt",
      "egyptian",
      "greek",
      "medieval",
      "empire",
      "kingdom",
      "battle",
      "castle",
      "archaeology",
      "civilization",
    ],
    visualWorld:
      "Historical documentary world: period-accurate architecture, clothing, tools, roads, documents, ruins, landscapes, armies, workshops, temples, and archaeological details matched to the named era and place.",
    allowed:
      "Use artifact details, period streets, maps, ruins, torch or daylight ambience, craftspeople, soldiers, rulers from behind or at distance, and historically plausible materials.",
    bridge:
      "For abstract politics, power, trade, or belief, show era-specific documents, marketplaces, roads, temples, gates, official seals, or archaeological remains.",
    avoid:
      "Avoid modern clothing, modern roads and interiors, fantasy armor, anachronistic technology, generic castles for non-medieval topics, and unrelated landscapes.",
  },
];

export function inferChannelSettings(input: ChannelIdeaInput): ChannelInference {
  const idea = normalize(`${input.name} ${input.description ?? ""}`);
  const scored = PROFILES.map((profile) => ({ profile, score: scoreProfile(idea, profile) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const profile = best?.score > 0 ? best.profile : genericProfile(input.name, input.description);
  const confidence = best?.score > 0 ? Math.min(1, best.score / 5) : 0.25;
  const stylePresetId = chooseStylePresetId(idea, input.stylePresetId);
  const baseStyle = loadStylePreset(stylePresetId).defaults.videoStyle;
  const visualDoctrine = buildVisualDoctrine(profile, input.name, input.description);

  return {
    domainId: profile.id,
    domainLabel: profile.label,
    confidence,
    stylePresetId,
    stockFolder: profile.folder,
    videoModel: "veo-3.1-fast",
    aspectRatio: "16:9",
    visualDoctrine,
    videoStyle: [visualDoctrine, baseStyle].filter(Boolean).join(" "),
  };
}

export function isStylePresetDefault(videoStyle: string | null | undefined, stylePresetId: string | null | undefined): boolean {
  const clean = normalize(videoStyle ?? "");
  if (!clean) return true;
  return (
    clean === normalize(loadStylePreset(stylePresetId ?? DEFAULT_STYLE_PRESET_ID).defaults.videoStyle) ||
    STYLE_PRESETS.some((preset) => clean === normalize(preset.defaults.videoStyle))
  );
}

function buildVisualDoctrine(profile: DomainProfile, name: string, description?: string | null): string {
  const idea = [name.trim(), description?.trim()].filter(Boolean).join(" — ");
  return [
    `Channel visual doctrine (${profile.label}${idea ? `, inferred from "${idea}"` : ""}): ${profile.visualWorld}`,
    profile.allowed,
    profile.bridge,
    profile.avoid,
    TEXT_MATCH_RULE,
    "One cinematic full-frame shot per prompt. No text, captions, logos, watermarks, UI, collage, split-screen, or unrelated establishing shots.",
  ].join(" ");
}

function scoreProfile(idea: string, profile: DomainProfile): number {
  let score = 0;
  for (const keyword of profile.keywords) {
    const k = normalize(keyword);
    if (!k) continue;
    if (idea.includes(k)) score += k.includes(" ") ? 3 : 1;
  }
  return score;
}

function chooseStylePresetId(idea: string, explicit?: string | null): string {
  const explicitClean = explicit?.trim();
  if (explicitClean && explicitClean !== DEFAULT_STYLE_PRESET_ID) return explicitClean;
  if (/\b(sleep|sleepy|calm|relax|relaxation|bedtime|night|midnight|quiet)\b/i.test(idea)) {
    return "sleep-calm";
  }
  return "standard-neutral";
}

function genericProfile(name: string, description?: string | null): DomainProfile {
  const label = name.trim() || "Documentary";
  const idea = [name.trim(), description?.trim()].filter(Boolean).join(", ");
  return {
    id: "custom-documentary",
    label: `${label} Documentary`,
    folder: defaultFolderName(label),
    keywords: [],
    visualWorld:
      `Documentary world inferred from the channel idea${idea ? ` (${idea})` : ""}: keep visuals tightly tied to the subject, setting, era, objects, people, places, and scale implied by the narration.`,
    allowed:
      "Use concrete, literal, subject-specific imagery and documentary camera language. Let the script choose the subject before mood or decoration.",
    bridge:
      "For abstract ideas, translate them through the channel's own subject matter instead of switching to generic symbolic scenes.",
    avoid:
      "Avoid unrelated stock imagery, generic landscapes, modern objects when the text implies another era, fantasy, cartoons, and visual metaphors that ignore the narration.",
  };
}

function defaultFolderName(channelName: string): string {
  const trimmed = channelName.trim();
  if (!trimmed) return "Channel";
  const slug = trimmed
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.slice(0, 64) || "Channel";
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}
