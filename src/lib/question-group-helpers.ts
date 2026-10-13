import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { mediaAssets, mockTestSections, mockTests, questionGroups, questions, attemptResponses } from "@/db/schema";
import { storage } from "@/lib/storage";
import { validateAnswerForType, type QuestionType } from "@/lib/validations/questions";
import { blocksSchema, type Block, type ResolvedBlock } from "@/lib/validations/blocks";

export function imageIdsOf(blocks: Block[]): string[] {
  return [...new Set(blocks.flatMap((b) => (b.type === "image" ? [b.imageId] : [])))];
}

/** Coerces the jsonb column to a valid blocks array (invalid legacy data -> []). */
export function parseBlocks(raw: unknown): Block[] {
  const r = blocksSchema.safeParse(raw ?? []);
  return r.success ? r.data : [];
}

/** Returns image ids from `blocks` that do NOT belong to the organization. */
export async function findForeignImageIds(blocks: Block[], organizationId: string): Promise<string[]> {
  const ids = imageIdsOf(blocks);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(and(inArray(mediaAssets.id, ids), eq(mediaAssets.organizationId, organizationId)));
  const ok = new Set(rows.map((r) => r.id));
  return ids.filter((id) => !ok.has(id));
}

/** Resolves image blocks to carry `url` (org-scoped); images that can't be found are dropped. */
export async function resolveBlocks(
  blocks: Block[],
  organizationId: string
): Promise<{ blocks: ResolvedBlock[]; images: Record<string, { id: string; title: string; url: string }> }> {
  const ids = imageIdsOf(blocks);
  const images: Record<string, { id: string; title: string; url: string }> = {};
  if (ids.length > 0) {
    const rows = await db
      .select()
      .from(mediaAssets)
      .where(and(inArray(mediaAssets.id, ids), eq(mediaAssets.organizationId, organizationId)));
    for (const r of rows) images[r.id] = { id: r.id, title: r.title, url: storage.getUrl(r.storageKey) };
  }
  const resolved: ResolvedBlock[] = [];
  for (const b of blocks) {
    if (b.type === "image") {
      const img = images[b.imageId];
      if (!img) continue;
      resolved.push({ ...b, url: img.url });
    } else resolved.push(b);
  }
  return { blocks: resolved, images };
}

function blockTexts(b: Block): string[] {
  if (b.type === "text") return [b.text];
  if (b.type === "table") return [...b.headers, ...b.rows.flat()];
  return [];
}

export type Readiness = { ready: boolean; issues: string[]; warnings: string[] };

export async function computeGroupReadiness(group: typeof questionGroups.$inferSelect): Promise<Readiness> {
  const issues: string[] = [];
  const warnings: string[] = [];
  const blocks = parseBlocks(group.blocks);
  const qs = await db
    .select()
    .from(questions)
    .where(eq(questions.questionGroupId, group.id));

  if (qs.length === 0) issues.push("Add at least one question.");
  if (group.section === "READING" && !group.passageId) issues.push("A Reading group must reference a passage.");
  if (group.section === "LISTENING" && !group.audioId) issues.push("A Listening group must reference an audio asset.");

  const foreign = await findForeignImageIds(blocks, group.organizationId);
  if (foreign.length > 0) issues.push("An image block references an image that no longer exists.");

  const optionsBlock = blocks.find((b) => b.type === "options");
  const sorted = [...qs].sort((a, b) => a.orderIndex - b.orderIndex);
  sorted.forEach((q, i) => {
    const n = i + 1;
    const err = validateAnswerForType(q.questionType as QuestionType, q.correctAnswer);
    if (err) issues.push(`Question ${n}: ${err}`);
    if (q.questionType === "MATCHING" || q.questionType === "MAP_LABELING") {
      if (!optionsBlock || optionsBlock.type !== "options") {
        issues.push(`Question ${n}: add an options list block to the group.`);
      } else {
        const idx = (q.correctAnswer as { correctOptionIndex?: number })?.correctOptionIndex;
        if (typeof idx === "number" && idx >= optionsBlock.options.length) {
          issues.push(`Question ${n}: correct option is outside the options list.`);
        }
      }
    }
  });

  const anchors = new Set<number>();
  for (const b of blocks)
    for (const t of blockTexts(b)) for (const m of t.matchAll(/\[\[(\d+)\]\]/g)) anchors.add(Number(m[1]));
  for (const n of [...anchors].sort((a, b) => a - b)) {
    if (n > qs.length || n < 1) warnings.push(`Blank [[${n}]] has no matching question.`);
  }

  return { ready: issues.length === 0, issues, warnings };
}

/** Mock tests (name list) whose sections reference any of these group ids. */
export async function mockTestsUsingGroups(organizationId: string, groupIds: string[]): Promise<string[]> {
  if (groupIds.length === 0) return [];
  const rows = await db
    .select({ title: mockTests.title, ids: mockTestSections.questionGroupIds })
    .from(mockTestSections)
    .innerJoin(mockTests, eq(mockTestSections.mockTestId, mockTests.id))
    .where(eq(mockTests.organizationId, organizationId));
  const set = new Set(groupIds);
  return [...new Set(rows.filter((r) => (r.ids ?? []).some((id) => set.has(id))).map((r) => r.title))];
}

export async function countAttemptResponses(questionIds: string[]): Promise<number> {
  if (questionIds.length === 0) return 0;
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(attemptResponses)
    .where(inArray(attemptResponses.questionId, questionIds));
  return r?.n ?? 0;
}
