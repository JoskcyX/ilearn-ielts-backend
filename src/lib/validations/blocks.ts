import { z } from "zod";

/**
 * A question group's "stimulus" is an ordered list of content blocks shown
 * above its questions (diagram image, data table, notes with blanks, a shared
 * lettered option list for matching/map questions...). Stored as jsonb on
 * question_groups.blocks. Contains NO answers, so it is safe to send to students.
 *
 * `[[n]]` inside text / table cells marks the blank for question number n
 * (1-based position of the question within the group).
 */
export const blockSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1), type: z.literal("text"), text: z.string().max(20000) }),
  z.object({
    id: z.string().min(1),
    type: z.literal("image"),
    imageId: z.string().uuid(),
    caption: z.string().max(300).optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("table"),
    caption: z.string().max(300).optional(),
    headers: z.array(z.string().max(300)).max(12),
    rows: z.array(z.array(z.string().max(1000)).max(12)).max(60),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("options"),
    title: z.string().max(200).optional(),
    options: z.array(z.string().trim().min(1).max(300)).min(2).max(26),
  }),
]);
export const blocksSchema = z.array(blockSchema).max(30);

export type Block = z.infer<typeof blockSchema>;
/** What students/preview receive: image blocks gain a resolved `url`. */
export type ResolvedBlock = Block | (Extract<Block, { type: "image" }> & { url: string });
