/**
 * Deterministic pastel color-per-product for the /macro-codes tab
 * (Will's brief, verbatim: "Use color coding to differentiate the
 * vaccines from one another (ex: all shingles rows are the same
 * color)"). Keyed by productKey (not by macro-catalog "type" — MMR-II
 * and Priorix share the type "MMR" but are different products, and
 * Will's brief separately calls out that the two MUST still get
 * different colors), so every row of a given product renders with the
 * same subtle background across every section it appears in.
 */

/** Cheap string hash (djb2) -> a 0-359 hue, stable across runs/builds
 * (no Math.random, no iteration-order dependence). */
function hashToHue(key: string): number {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 33) ^ key.charCodeAt(i);
  }
  // >>> 0 forces an unsigned 32-bit value before the modulo.
  return (hash >>> 0) % 360;
}

export type MacroProductColor = { background: string; text: string };

/** Light, subtle background + a readable dark text tone at the same
 * hue — kept low-saturation/high-lightness so it stays subtle next to
 * the copy/settings controls, per Will's "keep it subtle" spirit
 * (round-2 brief overall asks for succinct/compact, not loud). */
export function macroProductColor(productKey: string): MacroProductColor {
  const hue = hashToHue(productKey);
  return {
    background: `hsl(${hue} 55% 93%)`,
    text: `hsl(${hue} 45% 28%)`,
  };
}
