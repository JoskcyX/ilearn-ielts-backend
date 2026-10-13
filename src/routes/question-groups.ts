import { Router } from "express";
import { eq, and, desc, asc, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { questionGroups, passages, audioAssets, questions } from "@/db/schema";
import { requireRole } from "@/middleware/auth";
import {
  createQuestionGroupSchema,
  updateQuestionGroupSchema,
  SECTIONS,
  TEST_TYPES,
} from "@/lib/validations/question-groups";
import {
  computeGroupReadiness,
  countAttemptResponses,
  findForeignImageIds,
  mockTestsUsingGroups,
  parseBlocks,
  resolveBlocks,
} from "@/lib/question-group-helpers";
import { writeAuditLog } from "@/lib/audit";
import { statusBodySchema } from "./passages";

export const questionGroupsRouter = Router();
questionGroupsRouter.use(requireRole("ADMIN"));

// GET /api/admin/question-groups?section=&testType=&status=&q=
questionGroupsRouter.get("/", async (req, res) => {
  const admin = req.user!;
  const { section, testType, status, q } = req.query as Record<string, string | undefined>;
  const conds = [eq(questionGroups.organizationId, admin.organizationId)];
  if (section && (SECTIONS as readonly string[]).includes(section))
    conds.push(eq(questionGroups.section, section as (typeof SECTIONS)[number]));
  if (testType && (TEST_TYPES as readonly string[]).includes(testType))
    conds.push(eq(questionGroups.testType, testType as (typeof TEST_TYPES)[number]));
  if (status && ["DRAFT", "PUBLISHED", "ARCHIVED"].includes(status))
    conds.push(eq(questionGroups.status, status as "DRAFT" | "PUBLISHED" | "ARCHIVED"));
  if (q && q.trim()) {
    const like = `%${q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(or(ilike(questionGroups.title, like), ilike(questionGroups.instructions, like))!);
  }

  const [groups, orgPassages, orgAudio] = await Promise.all([
    db
      .select({
        id: questionGroups.id,
        organizationId: questionGroups.organizationId,
        title: questionGroups.title,
        section: questionGroups.section,
        testType: questionGroups.testType,
        part: questionGroups.part,
        status: questionGroups.status,
        instructions: questionGroups.instructions,
        passageId: questionGroups.passageId,
        audioId: questionGroups.audioId,
        createdBy: questionGroups.createdBy,
        createdAt: questionGroups.createdAt,
        updatedAt: questionGroups.updatedAt,
        questionCount: sql<number>`(select count(*)::int from "questions" qq where qq."question_group_id" = "question_groups"."id")`,
      })
      .from(questionGroups)
      .where(and(...conds))
      .orderBy(desc(questionGroups.createdAt)),
    db
      .select({ id: passages.id, title: passages.title })
      .from(passages)
      .where(eq(passages.organizationId, admin.organizationId)),
    db
      .select({ id: audioAssets.id, title: audioAssets.title })
      .from(audioAssets)
      .where(eq(audioAssets.organizationId, admin.organizationId)),
  ]);
  res.json({ groups, passages: orgPassages, audioAssets: orgAudio });
});

// GET /api/admin/question-groups/:groupId
questionGroupsRouter.get("/:groupId", async (req, res) => {
  const admin = req.user!;
  const groupId = req.params.groupId;

  const [group] = await db
    .select()
    .from(questionGroups)
    .where(and(eq(questionGroups.id, groupId), eq(questionGroups.organizationId, admin.organizationId)))
    .limit(1);
  if (!group) return res.status(404).json({ error: "NOT_FOUND" });

  const [passage] = group.passageId
    ? await db.select().from(passages).where(eq(passages.id, group.passageId)).limit(1)
    : [null];
  const [audio] = group.audioId
    ? await db.select().from(audioAssets).where(eq(audioAssets.id, group.audioId)).limit(1)
    : [null];

  const groupQuestions = await db
    .select()
    .from(questions)
    .where(eq(questions.questionGroupId, groupId))
    .orderBy(asc(questions.orderIndex));

  const [{ images }, readiness] = await Promise.all([
    resolveBlocks(parseBlocks(group.blocks), admin.organizationId),
    computeGroupReadiness(group),
  ]);

  res.json({
    group: { ...group, blocks: parseBlocks(group.blocks) },
    passage: passage ?? null,
    audio: audio ?? null,
    images,
    questions: groupQuestions,
    readiness,
  });
});

// POST /api/admin/question-groups
questionGroupsRouter.post("/", async (req, res) => {
  const admin = req.user!;
  const parsed = createQuestionGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const { section, testType, part, title, instructions, passageId, audioId, blocks } = parsed.data;

  // Referenced content, if any, must belong to this admin's organization.
  if (passageId) {
    const [p] = await db
      .select({ id: passages.id })
      .from(passages)
      .where(and(eq(passages.id, passageId), eq(passages.organizationId, admin.organizationId)))
      .limit(1);
    if (!p) return res.status(404).json({ success: false, error: "Passage not found." });
  }
  if (audioId) {
    const [a] = await db
      .select({ id: audioAssets.id })
      .from(audioAssets)
      .where(and(eq(audioAssets.id, audioId), eq(audioAssets.organizationId, admin.organizationId)))
      .limit(1);
    if (!a) return res.status(404).json({ success: false, error: "Audio asset not found." });
  }

  if (blocks && blocks.length > 0) {
    const foreign = await findForeignImageIds(blocks, admin.organizationId);
    if (foreign.length > 0) return res.status(404).json({ success: false, error: "Image not found." });
  }

  const [group] = await db
    .insert(questionGroups)
    .values({
      organizationId: admin.organizationId,
      section,
      testType,
      part,
      title: title || null,
      instructions,
      blocks: blocks ?? [],
      passageId: passageId ?? null,
      audioId: audioId ?? null,
      createdBy: admin.id,
    })
    .returning();

  await writeAuditLog({
    userId: admin.id,
    action: "QUESTION_GROUP_CREATED",
    targetType: "question_group",
    targetId: group.id,
    metadata: { section, testType, part },
  });

  res.json({ success: true, id: group.id });
});

// PATCH /api/admin/question-groups/:groupId/status  { status }
questionGroupsRouter.patch("/:groupId/status", async (req, res) => {
  const admin = req.user!;
  const parsed = statusBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid status" });
  const { status } = parsed.data;
  const groupId = req.params.groupId;

  const [existing] = await db
    .select({ id: questionGroups.id })
    .from(questionGroups)
    .where(and(eq(questionGroups.id, groupId), eq(questionGroups.organizationId, admin.organizationId)))
    .limit(1);
  if (!existing) return res.status(404).json({ success: false, error: "Question group not found." });

  await db.update(questionGroups).set({ status }).where(eq(questionGroups.id, groupId));

  await writeAuditLog({
    userId: admin.id,
    action: "QUESTION_GROUP_STATUS_CHANGED",
    targetType: "question_group",
    targetId: groupId,
    metadata: { status },
  });

  res.json({ success: true });
});

async function getOwnedGroup(groupId: string, organizationId: string) {
  const [g] = await db
    .select()
    .from(questionGroups)
    .where(and(eq(questionGroups.id, groupId), eq(questionGroups.organizationId, organizationId)))
    .limit(1);
  return g ?? null;
}

// PUT /api/admin/question-groups/:groupId  (partial update)
questionGroupsRouter.put("/:groupId", async (req, res) => {
  const admin = req.user!;
  const groupId = req.params.groupId as string;
  const parsed = updateQuestionGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const data = parsed.data;
  const existing = await getOwnedGroup(groupId, admin.organizationId);
  if (!existing) return res.status(404).json({ success: false, error: "Question group not found." });

  const section = data.section ?? existing.section;
  const passageId = data.passageId === undefined ? existing.passageId : data.passageId;
  const audioId = data.audioId === undefined ? existing.audioId : data.audioId;
  if (section === "READING" && !passageId)
    return res.status(400).json({ success: false, error: "A Reading question group must reference a passage." });
  if (section === "LISTENING" && !audioId)
    return res.status(400).json({ success: false, error: "A Listening question group must reference an audio asset." });

  if (data.passageId) {
    const [p] = await db
      .select({ id: passages.id })
      .from(passages)
      .where(and(eq(passages.id, data.passageId), eq(passages.organizationId, admin.organizationId)))
      .limit(1);
    if (!p) return res.status(404).json({ success: false, error: "Passage not found." });
  }
  if (data.audioId) {
    const [a] = await db
      .select({ id: audioAssets.id })
      .from(audioAssets)
      .where(and(eq(audioAssets.id, data.audioId), eq(audioAssets.organizationId, admin.organizationId)))
      .limit(1);
    if (!a) return res.status(404).json({ success: false, error: "Audio asset not found." });
  }
  if (data.blocks && data.blocks.length > 0) {
    const foreign = await findForeignImageIds(data.blocks, admin.organizationId);
    if (foreign.length > 0) return res.status(404).json({ success: false, error: "Image not found." });
  }

  const patch: Partial<typeof questionGroups.$inferInsert> = { updatedAt: new Date() };
  if (data.section !== undefined) patch.section = data.section;
  if (data.testType !== undefined) patch.testType = data.testType;
  if (data.part !== undefined) patch.part = data.part;
  if (data.title !== undefined) patch.title = data.title || null;
  if (data.instructions !== undefined) patch.instructions = data.instructions;
  if (data.passageId !== undefined) patch.passageId = data.passageId;
  if (data.audioId !== undefined) patch.audioId = data.audioId;
  if (data.blocks !== undefined) patch.blocks = data.blocks;

  await db.update(questionGroups).set(patch).where(eq(questionGroups.id, groupId));

  await writeAuditLog({
    userId: admin.id,
    action: "QUESTION_GROUP_UPDATED",
    targetType: "question_group",
    targetId: groupId,
    metadata: { fields: Object.keys(data) },
  });
  res.json({ success: true });
});

// DELETE /api/admin/question-groups/:groupId
questionGroupsRouter.delete("/:groupId", async (req, res) => {
  const admin = req.user!;
  const groupId = req.params.groupId as string;
  const existing = await getOwnedGroup(groupId, admin.organizationId);
  if (!existing) return res.status(404).json({ success: false, error: "Question group not found." });

  const usedIn = await mockTestsUsingGroups(admin.organizationId, [groupId]);
  if (usedIn.length > 0) {
    return res.status(409).json({
      success: false,
      error: `This group is used by mock test${usedIn.length === 1 ? "" : "s"}: ${usedIn.join(", ")}. Remove it from the test first.`,
    });
  }
  const qs = await db.select({ id: questions.id }).from(questions).where(eq(questions.questionGroupId, groupId));
  const responses = await countAttemptResponses(qs.map((q) => q.id));
  if (responses > 0) {
    return res.status(409).json({
      success: false,
      error: "Students have already answered questions in this group, so it cannot be deleted. Archive it instead.",
    });
  }

  await db.delete(questionGroups).where(eq(questionGroups.id, groupId));
  await writeAuditLog({
    userId: admin.id,
    action: "QUESTION_GROUP_DELETED",
    targetType: "question_group",
    targetId: groupId,
  });
  res.json({ success: true });
});

// POST /api/admin/question-groups/:groupId/duplicate
questionGroupsRouter.post("/:groupId/duplicate", async (req, res) => {
  const admin = req.user!;
  const groupId = req.params.groupId as string;
  const existing = await getOwnedGroup(groupId, admin.organizationId);
  if (!existing) return res.status(404).json({ success: false, error: "Question group not found." });

  const srcQuestions = await db
    .select()
    .from(questions)
    .where(eq(questions.questionGroupId, groupId))
    .orderBy(asc(questions.orderIndex));

  const newId = await db.transaction(async (tx) => {
    const [copy] = await tx
      .insert(questionGroups)
      .values({
        organizationId: admin.organizationId,
        section: existing.section,
        testType: existing.testType,
        part: existing.part,
        title: existing.title ? `${existing.title} (copy)`.slice(0, 200) : null,
        instructions: existing.instructions,
        blocks: parseBlocks(existing.blocks),
        passageId: existing.passageId,
        audioId: existing.audioId,
        status: "DRAFT",
        createdBy: admin.id,
      })
      .returning({ id: questionGroups.id });
    if (srcQuestions.length > 0) {
      await tx.insert(questions).values(
        srcQuestions.map((q) => ({
          questionGroupId: copy.id,
          questionType: q.questionType,
          questionText: q.questionText,
          orderIndex: q.orderIndex,
          difficulty: q.difficulty,
          skill: q.skill,
          marks: q.marks,
          correctAnswer: q.correctAnswer,
          explanation: q.explanation,
          status: "DRAFT" as const,
        }))
      );
    }
    return copy.id;
  });

  await writeAuditLog({
    userId: admin.id,
    action: "QUESTION_GROUP_DUPLICATED",
    targetType: "question_group",
    targetId: newId,
    metadata: { sourceId: groupId },
  });
  res.json({ success: true, id: newId });
});
