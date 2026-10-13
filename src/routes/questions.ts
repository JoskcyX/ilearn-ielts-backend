import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/db";
import { questions, questionGroups } from "@/db/schema";
import { requireRole } from "@/middleware/auth";
import {
  createQuestionSchema,
  updateQuestionSchema,
  validateAnswerForType,
} from "@/lib/validations/questions";
import { z } from "zod";
import { countAttemptResponses } from "@/lib/question-group-helpers";
import { writeAuditLog } from "@/lib/audit";
import { statusBodySchema } from "./passages";

export const questionsRouter = Router();
questionsRouter.use(requireRole("ADMIN"));

// POST /api/admin/questions
questionsRouter.post("/", async (req, res) => {
  const admin = req.user!;
  const parsed = createQuestionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const data = parsed.data;

  const [group] = await db
    .select({ id: questionGroups.id })
    .from(questionGroups)
    .where(
      and(
        eq(questionGroups.id, data.questionGroupId),
        eq(questionGroups.organizationId, admin.organizationId)
      )
    )
    .limit(1);
  if (!group) return res.status(404).json({ success: false, error: "Question group not found." });

  const [created] = await db.insert(questions).values({
    questionGroupId: data.questionGroupId,
    questionType: data.questionType,
    questionText: data.questionText,
    orderIndex: data.orderIndex,
    marks: data.marks,
    difficulty: data.difficulty ?? null,
    skill: data.skill ?? null,
    explanation: data.explanation ?? null,
    correctAnswer: data.correctAnswer,
  }).returning({ id: questions.id });

  await touchGroup(data.questionGroupId);
  await writeAuditLog({
    userId: admin.id,
    action: "QUESTION_CREATED",
    targetType: "question_group",
    targetId: data.questionGroupId,
    metadata: { questionType: data.questionType },
  });

  res.json({ success: true, id: created.id });
});

async function touchGroup(groupId: string) {
  await db.update(questionGroups).set({ updatedAt: new Date() }).where(eq(questionGroups.id, groupId));
}

async function getOwnedQuestion(questionId: string, organizationId: string) {
  const [row] = await db
    .select({ q: questions, orgId: questionGroups.organizationId })
    .from(questions)
    .innerJoin(questionGroups, eq(questions.questionGroupId, questionGroups.id))
    .where(eq(questions.id, questionId))
    .limit(1);
  return row && row.orgId === organizationId ? row.q : null;
}

const reorderSchema = z.object({
  questionGroupId: z.string().uuid(),
  orderedIds: z.array(z.string().uuid()).min(1),
});

// POST /api/admin/questions/reorder  { questionGroupId, orderedIds }
questionsRouter.post("/reorder", async (req, res) => {
  const admin = req.user!;
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid input" });
  const { questionGroupId, orderedIds } = parsed.data;

  const [group] = await db
    .select({ id: questionGroups.id })
    .from(questionGroups)
    .where(and(eq(questionGroups.id, questionGroupId), eq(questionGroups.organizationId, admin.organizationId)))
    .limit(1);
  if (!group) return res.status(404).json({ success: false, error: "Question group not found." });

  const existing = await db.select({ id: questions.id }).from(questions).where(eq(questions.questionGroupId, questionGroupId));
  const existingIds = new Set(existing.map((e) => e.id));
  if (
    new Set(orderedIds).size !== orderedIds.length ||
    orderedIds.length !== existingIds.size ||
    !orderedIds.every((id) => existingIds.has(id))
  ) {
    return res.status(400).json({ success: false, error: "orderedIds must list every question in the group exactly once." });
  }

  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx.update(questions).set({ orderIndex: i }).where(eq(questions.id, orderedIds[i]));
    }
    await tx.update(questionGroups).set({ updatedAt: new Date() }).where(eq(questionGroups.id, questionGroupId));
  });
  await writeAuditLog({
    userId: admin.id,
    action: "QUESTIONS_REORDERED",
    targetType: "question_group",
    targetId: questionGroupId,
  });
  res.json({ success: true });
});

// POST /api/admin/questions/bulk  { questionGroupId, questions: [...] }  (all-or-nothing)
questionsRouter.post("/bulk", async (req, res) => {
  const admin = req.user!;
  const groupId = z.string().uuid().safeParse(req.body?.questionGroupId);
  const items = req.body?.questions;
  if (!groupId.success || !Array.isArray(items) || items.length === 0 || items.length > 200) {
    return res.status(400).json({ success: false, error: "Provide questionGroupId and 1-200 questions." });
  }
  const [group] = await db
    .select({ id: questionGroups.id })
    .from(questionGroups)
    .where(and(eq(questionGroups.id, groupId.data), eq(questionGroups.organizationId, admin.organizationId)))
    .limit(1);
  if (!group) return res.status(404).json({ success: false, error: "Question group not found." });

  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${questions.orderIndex}) + 1, 0)::int` })
    .from(questions)
    .where(eq(questions.questionGroupId, groupId.data));

  const rows: (typeof questions.$inferInsert)[] = [];
  for (let i = 0; i < items.length; i++) {
    const raw = items[i] as Record<string, unknown>;
    const parsed = createQuestionSchema.safeParse({ ...raw, questionGroupId: groupId.data });
    if (!parsed.success) {
      return res
        .status(400)
        .json({ success: false, error: `Question ${i + 1}: ${parsed.error.issues[0]?.message ?? "Invalid input"}` });
    }
    const d = parsed.data;
    rows.push({
      questionGroupId: groupId.data,
      questionType: d.questionType,
      questionText: d.questionText,
      orderIndex: raw.orderIndex === undefined ? next + i : d.orderIndex,
      marks: d.marks,
      difficulty: d.difficulty ?? null,
      skill: d.skill ?? null,
      explanation: d.explanation ?? null,
      correctAnswer: d.correctAnswer,
    });
  }

  const created = await db.transaction(async (tx) => {
    const out = await tx.insert(questions).values(rows).returning({ id: questions.id });
    await tx.update(questionGroups).set({ updatedAt: new Date() }).where(eq(questionGroups.id, groupId.data));
    return out;
  });
  await writeAuditLog({
    userId: admin.id,
    action: "QUESTIONS_BULK_CREATED",
    targetType: "question_group",
    targetId: groupId.data,
    metadata: { count: created.length },
  });
  res.json({ success: true, ids: created.map((c) => c.id) });
});

// PUT /api/admin/questions/:id
questionsRouter.put("/:id", async (req, res) => {
  const admin = req.user!;
  const questionId = req.params.id as string;
  const parsed = updateQuestionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const data = parsed.data;
  const existing = await getOwnedQuestion(questionId, admin.organizationId);
  if (!existing) return res.status(404).json({ success: false, error: "Question not found." });

  const type = data.questionType ?? existing.questionType;
  if (data.questionType && data.questionType !== existing.questionType && data.correctAnswer === undefined) {
    return res.status(400).json({ success: false, error: "Changing the question type requires a new answer." });
  }
  if (data.correctAnswer !== undefined) {
    const err = validateAnswerForType(type, data.correctAnswer);
    if (err) return res.status(400).json({ success: false, error: err });
  }

  const patch: Partial<typeof questions.$inferInsert> = {};
  if (data.questionType !== undefined) patch.questionType = data.questionType;
  if (data.questionText !== undefined) patch.questionText = data.questionText;
  if (data.marks !== undefined) patch.marks = data.marks;
  if (data.difficulty !== undefined) patch.difficulty = data.difficulty || null;
  if (data.skill !== undefined) patch.skill = data.skill || null;
  if (data.explanation !== undefined) patch.explanation = data.explanation || null;
  if (data.correctAnswer !== undefined) patch.correctAnswer = data.correctAnswer;
  if (Object.keys(patch).length > 0) {
    await db.update(questions).set(patch).where(eq(questions.id, questionId));
    await touchGroup(existing.questionGroupId);
  }

  await writeAuditLog({
    userId: admin.id,
    action: "QUESTION_UPDATED",
    targetType: "question",
    targetId: questionId,
    metadata: { fields: Object.keys(patch) },
  });
  res.json({ success: true });
});

// DELETE /api/admin/questions/:id
questionsRouter.delete("/:id", async (req, res) => {
  const admin = req.user!;
  const questionId = req.params.id as string;
  const existing = await getOwnedQuestion(questionId, admin.organizationId);
  if (!existing) return res.status(404).json({ success: false, error: "Question not found." });

  if ((await countAttemptResponses([questionId])) > 0) {
    return res.status(409).json({
      success: false,
      error: "Students have already answered this question, so it cannot be deleted. Archive it instead.",
    });
  }
  await db.delete(questions).where(eq(questions.id, questionId));
  await touchGroup(existing.questionGroupId);
  await writeAuditLog({
    userId: admin.id,
    action: "QUESTION_DELETED",
    targetType: "question",
    targetId: questionId,
  });
  res.json({ success: true });
});

// PATCH /api/admin/questions/:id/status  { status }
questionsRouter.patch("/:id/status", async (req, res) => {
  const admin = req.user!;
  const parsed = statusBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid status" });
  const { status } = parsed.data;
  const questionId = req.params.id;

  // Ownership check goes through the parent group's organizationId.
  const [row] = await db
    .select({ questionGroupId: questions.questionGroupId, orgId: questionGroups.organizationId })
    .from(questions)
    .innerJoin(questionGroups, eq(questions.questionGroupId, questionGroups.id))
    .where(eq(questions.id, questionId))
    .limit(1);

  if (!row || row.orgId !== admin.organizationId) {
    return res.status(404).json({ success: false, error: "Question not found." });
  }

  await db.update(questions).set({ status }).where(eq(questions.id, questionId));

  await writeAuditLog({
    userId: admin.id,
    action: "QUESTION_STATUS_CHANGED",
    targetType: "question",
    targetId: questionId,
    metadata: { status },
  });

  res.json({ success: true });
});
