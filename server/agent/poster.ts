/**
 * Posters and flyers. Hera writes the words and picks a style; the app draws the poster itself
 * (with the person's brand colors and logo) in every size: a square post, a Story, a wide banner
 * and a printable flyer. Drawing on the device keeps text sharp and correctly spelled, costs
 * nothing per poster, and nothing is published: the person shares or prints it themselves.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { postContentChecks } from "./policy.ts";

export const POSTER_STYLES = ["bold", "elegant", "playful", "minimal"] as const;

export interface PosterDraft {
  id: string;
  style: (typeof POSTER_STYLES)[number];
  headline: string;
  subheadline: string | null;
  /** Short lines: the date and time, the place, the price… */
  details: string[];
  callToAction: string | null;
  /** Small print at the bottom, e.g. the website or social handle. */
  footer: string | null;
  /** One or two emoji to decorate it, or null. */
  emoji: string | null;
  /** Use the photo the person attached, if any. */
  usePhoto: boolean;
  /** Content concerns to show the person (unsupported claims and the like). */
  problems: Array<{ id: string; level: string; message: string }>;
}

const obj = (properties: Record<string, unknown>) => ({
  type: "object" as const, properties, required: Object.keys(properties), additionalProperties: false,
});

export const POSTER_TOOL = {
  name: "design_poster",
  description: "Design a poster or flyer for the person to share or print. You write the words and choose a style; the app draws it with their brand colors and logo in every size (square post, Story, banner, printable flyer). Keep it short: posters are read in seconds.",
  strict: true,
  input_schema: obj({
    style: { type: "string", enum: [...POSTER_STYLES], description: "bold (big and loud: sales, launches), elegant (refined: salons, dinners), playful (fun: kids, classes, food), minimal (clean: professional services)" },
    headline: { type: "string", description: "At most about six words, e.g. \"Pottery Workshop\"" },
    subheadline: { type: ["string", "null"], description: "One short line under the headline, or null" },
    details: { type: "array", items: { type: "string" }, description: "Up to 4 short lines, e.g. \"Sat, Nov 20 · 6 PM\", \"Clay Corner, 12 Main St\", \"$40 · 8 spots\"" },
    call_to_action: { type: ["string", "null"], description: "e.g. \"Book now\", or null" },
    footer: { type: ["string", "null"], description: "Website or handle, or null" },
    emoji: { type: ["string", "null"], description: "One or two fitting emoji, or null" },
    use_photo: { type: "boolean", description: "True to use the photo the person attached" },
  }),
};

export const POSTER_INPUT = z.object({
  style: z.enum(POSTER_STYLES),
  headline: z.string().min(1).max(60),
  subheadline: z.string().max(120).nullable(),
  details: z.array(z.string().min(1).max(80)).max(4),
  call_to_action: z.string().max(40).nullable(),
  footer: z.string().max(80).nullable(),
  emoji: z.string().max(16).nullable(),
  use_photo: z.boolean(),
}).strict();

export class PosterError extends Error {}

/** Turns a validated tool call into a poster, or explains what's wrong with it. */
export function makePoster(input: z.infer<typeof POSTER_INPUT>, hasPhoto: boolean): PosterDraft {
  if (input.use_photo && !hasPhoto) throw new PosterError("The person didn't attach a photo. Set use_photo to false, or ask them to add one.");
  // Emoji only: no words or links smuggled into the decoration.
  if (input.emoji && /[\p{L}\p{N}]/u.test(input.emoji)) throw new PosterError("emoji must be emoji only, or null.");
  const words = [input.headline, input.subheadline, ...input.details, input.call_to_action, input.footer].filter(Boolean).join("\n");
  // The same content rules as posts (no unsupported claims, no fake testimonials); a poster has no
  // length limit of its own here, so only the content checks apply.
  const problems = postContentChecks("facebook", words, null, false).filter((c) => c.id !== "too_long" && c.id !== "needs_media");
  return {
    id: `p_${randomBytes(6).toString("hex")}`,
    style: input.style,
    headline: input.headline.trim(),
    subheadline: input.subheadline?.trim() || null,
    details: input.details.map((d) => d.trim()).filter(Boolean),
    callToAction: input.call_to_action?.trim() || null,
    footer: input.footer?.trim() || null,
    emoji: input.emoji?.trim() || null,
    usePhoto: input.use_photo,
    problems: problems.map((c) => ({ id: c.id, level: c.level, message: c.message })),
  };
}
