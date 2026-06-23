#!/usr/bin/env node

const assert = require("node:assert/strict");

require("./register-ts.cjs");

const {
  FRESH_OPENING_SCENE_MAX_SECONDS,
  GENERATED_SCENE_WORDS_PER_SECOND,
  normalizeFreshOpeningScenes,
  validateFreshOpeningScenes,
} = require("../../src/lib/video-engine/scene-chunking.ts");
const { splitScriptAtNarrationDuration } = require("../../src/lib/video-engine/hybrid-fresh-boundary.ts");

console.log("Test 1 - deterministic fallback keeps natural phrase boundaries:");
{
  const text =
    "Tonight, picture a pirate ship after the cannons have gone quiet. " +
    "The deck is wet with moonlight, and every rope creaks like it remembers a storm. " +
    "A tired lookout lifts a brass spyglass, not to find treasure, but to check whether the horizon is finally empty. " +
    "Below him, the cook banks the fire, the navigator folds a salt-stained map, and the captain places one small silver coin beside the compass. " +
    "That coin is not payment. It is a promise to return home if the sea allows it. " +
    "For one slow minute, the ship feels almost peaceful. " +
    "Then a lantern swings by itself near the bow. " +
    "The lookout hears water tapping the hull in a pattern too steady to be waves. " +
    "The old map begins to curl at the edges, revealing a second coastline drawn underneath the first. Nobody speaks.";

  const scenes = normalizeFreshOpeningScenes([
    {
      index: 0,
      text,
      visual_prompt: "Pirate ship scene.",
      duration_hint_sec: 8,
    },
  ]);

  const validation = validateFreshOpeningScenes(scenes, text);
  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(
    scenes.some((scene) => scene.text.endsWith("salt-stained")),
    false,
    "Chunk should not end by splitting the phrase 'salt-stained map'."
  );
  assert.equal(
    scenes.some((scene) => scene.text === "That coin is not payment."),
    false,
    "Short sentence should be balanced with a neighboring beat."
  );
  console.log("  ok");
}

console.log("Test 2 - Brigantine opening keeps phrase-safe fresh chunks:");
{
  const text =
    "There's a word that sailors have argued over for 400 years and they still have not finished. " +
    "The word is Brigantine. " +
    "It sounds precise. " +
    "It sounds like the name of a single note. " +
    "But for most of its life the word meant whatever the person using it wanted it to mean. " +
    "It named one kind of vessel in the Mediterranean in the 1500s, something different in the North Atlantic a century later, and something different again by the time it appeared in the trial records and newspapers that gave us our pirates. " +
    "A brigantine could be a practical ship, a fashionable label, or a convenient confusion depending on who was speaking.";

  const scenes = normalizeFreshOpeningScenes([
    {
      index: 0,
      text,
      visual_prompt: "Historical maritime documentary shot.",
      duration_hint_sec: 8,
    },
  ]);

  const validation = validateFreshOpeningScenes(scenes, text);
  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(scenes.map((scene) => scene.text).join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
  assert.equal(scenes.some((scene) => /\bsingle,?$/i.test(scene.text)), false, "Chunk must not end on 'single'.");
  assert.equal(scenes.some((scene) => /\bNorth$/i.test(scene.text)), false, "Chunk must not split North Atlantic.");
  assert.equal(scenes.some((scene) => scene.text.trim().split(/\s+/).length < 4), false, "No short orphan chunks.");

  const joined = scenes.map((scene) => scene.text).join("\n---\n");
  assert.equal(/single,?\n---\nnote/i.test(joined), false, "single note must remain together.");
  assert.equal(/North\n---\nAtlantic/i.test(joined), false, "North Atlantic must remain together.");
  console.log("  ok");
}

console.log("Test 3 - HMS Victory opening is split below the fresh-video safety budget:");
{
  const text =
    "Somewhere in a dry dock in southern England, a single wooden warship still stands with three rows of gun ports cut into her sides. " +
    "To build her, shipwrights felled something on the order of six thousand trees, most of them oak, some of them four hundred years old, " +
    "cut from forests that had been growing since before the ship's first plank was ever imagined.";

  const scenes = normalizeFreshOpeningScenes([
    {
      index: 0,
      text,
      visual_prompt: "Historical ship-of-the-line dry dock documentary shot.",
      duration_hint_sec: 8,
    },
  ]);

  const validation = validateFreshOpeningScenes(scenes, text);
  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(scenes.map((scene) => scene.text).join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
  const safeMaxWords = Math.floor(FRESH_OPENING_SCENE_MAX_SECONDS * GENERATED_SCENE_WORDS_PER_SECOND) + 4;
  assert.equal(
    scenes.some((scene) => scene.text.trim().split(/\s+/).length > safeMaxWords),
    false,
    "Fresh chunks should keep a narration buffer under the provider's 8s video clip."
  );
  assert.equal(scenes.some((scene) => /\bgun$/i.test(scene.text)), false, "Chunk must not split gun ports.");
  console.log("  ok");
}

console.log("Test 4 - hybrid handoff prefers natural boundaries within tolerance:");
{
  const script =
    "There's a word that sailors have argued over for 400 years and they still have not finished. " +
    "The word is Brigantine. It sounds precise. It sounds like the name of a single note. " +
    "But for most of its life the word meant whatever the person using it wanted it to mean. " +
    "It named one kind of vessel in the Mediterranean in the 1500s, something different in the North Atlantic a century later, and something different again by the time it appeared in the trial records and newspapers that gave us our pirates. " +
    "This is the first clue to the real storm. The title of this video promises a raider every sailor prayed never to see. " +
    "But the more interesting truth is that the name itself was slippery, changing shape from harbour to harbour and decade to decade. " +
    "That slipperiness is where the story becomes useful, because it tells us how people talked about ships when the sea refused to fit tidy labels.";

  const targetSec = 54;
  const { freshText, tailText } = splitScriptAtNarrationDuration(script, targetSec);
  const approxFreshSec = freshText.trim().split(/\s+/).filter(Boolean).length / 2.5;
  assert.equal(freshText.length > 0, true);
  assert.equal(tailText.length > 0, true);
  assert.equal(Math.abs(approxFreshSec - targetSec) <= 10, true, `handoff drift ${approxFreshSec - targetSec}s`);
  assert.equal(/[.!?]$/.test(freshText.trim()), true, "Fresh handoff should end at a sentence boundary when available.");
  assert.equal(/^[a-z]/.test(tailText.trim()), false, "Stock tail must not start mid-phrase.");
  console.log("  ok");
}
