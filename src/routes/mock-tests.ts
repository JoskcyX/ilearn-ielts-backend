import { Router } from "express";
import { eq, and, asc, desc, max, sql, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  mockTests,
  mockTestSections,
  questionGroups,
  questions,
  passages,
  audioAssets,
} from "@/db/schema";
import { requireRole } from "@/middleware/auth";
import {
  createMockTestSchema,
  addSectionSchema,
  updateListeningReadingContentSchema,
  updateWritingContentSchema,
  updateSpeakingContentSchema,
} from "@/lib/validations/mock-tests";
import { computeGroupReadiness } from "@/lib/question-group-helpers";
import { writeAuditLog } from "@/lib/audit";

export const mockTestsRouter = Router();
mockTestsRouter.use(requireRole("ADMIN"));

async function getOwnedMockTest(mockTestId: string, organizationId: string) {
  const [mockTest] = await db
    .select()
    .from(mockTests)
    .where(and(eq(mockTests.id, mockTestId), eq(mockTests.organizationId, organizationId)))
    .limit(1);
  return mockTest ?? null;
}

async function getOwnedSection(sectionId: string, organizationId: string) {
  const [row] = await db
    .select({ section: mockTestSections, mockTest: mockTests })
    .from(mockTestSections)
    .innerJoin(mockTests, eq(mockTestSections.mockTestId, mockTests.id))
    .where(and(eq(mockTestSections.id, sectionId), eq(mockTests.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

const REQUIRED_SECTIONS = ["LISTENING", "READING", "WRITING", "SPEAKING"] as const;

// GET /api/admin/mock-tests
mockTestsRouter.get("/", async (req, res) => {
  const admin = req.user!;
  const orgMockTests = await db
    .select()
    .from(mockTests)
    .where(eq(mockTests.organizationId, admin.organizationId))
    .orderBy(desc(mockTests.createdAt));
  res.json({ mockTests: orgMockTests });
});

// POST /api/admin/mock-tests
mockTestsRouter.post("/", async (req, res) => {
  const admin = req.user!;
  const parsed = createMockTestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }

  const [mockTest] = await db
    .insert(mockTests)
    .values({
      organizationId: admin.organizationId,
      title: parsed.data.title,
      testType: parsed.data.testType,
      createdBy: admin.id,
    })
    .returning();

  await writeAuditLog({
    userId: admin.id,
    action: "MOCK_TEST_CREATED",
    targetType: "mock_test",
    targetId: mockTest.id,
  });

  res.json({ success: true, id: mockTest.id });
});

// GET /api/admin/mock-tests/:mockTestId  (builder page data)
mockTestsRouter.get("/:mockTestId", async (req, res) => {
  const admin = req.user!;
  const mockTestId = req.params.mockTestId;

  const mockTest = await getOwnedMockTest(mockTestId, admin.organizationId);
  if (!mockTest) return res.status(404).json({ error: "NOT_FOUND" });

  const sections = await db
    .select()
    .from(mockTestSections)
    .where(eq(mockTestSections.mockTestId, mockTestId))
    .orderBy(asc(mockTestSections.orderIndex));

  // Candidate question groups for Listening/Reading sections, with a
  // question count so the admin can see which groups are actually usable.
  const candidateGroups = await db
    .select({
      id: questionGroups.id,
      section: questionGroups.section,
      part: questionGroups.part,
      title: sql<string>`coalesce(${passages.title}, ${audioAssets.title}, 'Untitled')`,
      questionCount: sql<number>`count(${questions.id})`.mapWith(Number),
    })
    .from(questionGroups)
    .leftJoin(passages, eq(questionGroups.passageId, passages.id))
    .leftJoin(audioAssets, eq(questionGroups.audioId, audioAssets.id))
    .leftJoin(questions, eq(questions.questionGroupId, questionGroups.id))
    .where(
      and(
        eq(questionGroups.organizationId, admin.organizationId),
        eq(questionGroups.testType, mockTest.testType)
      )
    )
    .groupBy(questionGroups.id, passages.title, audioAssets.title);

  res.json({ mockTest, sections, candidateGroups });
});

// POST /api/admin/mock-tests/:mockTestId/sections
mockTestsRouter.post("/:mockTestId/sections", async (req, res) => {
  const admin = req.user!;
  const parsed = addSectionSchema.safeParse({ ...req.body, mockTestId: req.params.mockTestId });
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const { mockTestId, section, timeLimitSec } = parsed.data;

  const mockTest = await getOwnedMockTest(mockTestId, admin.organizationId);
  if (!mockTest) return res.status(404).json({ success: false, error: "Mock test not found." });
  if (mockTest.status !== "DRAFT") {
    return res.status(400).json({ success: false, error: "Only draft mock tests can be edited." });
  }

  const [existingSameSection] = await db
    .select({ id: mockTestSections.id })
    .from(mockTestSections)
    .where(and(eq(mockTestSections.mockTestId, mockTestId), eq(mockTestSections.section, section)))
    .limit(1);
  if (existingSameSection) {
    return res
      .status(400)
      .json({ success: false, error: `This mock test already has a ${section} section.` });
  }

  const [{ maxOrder }] = await db
    .select({ maxOrder: max(mockTestSections.orderIndex) })
    .from(mockTestSections)
    .where(eq(mockTestSections.mockTestId, mockTestId));

  await db.insert(mockTestSections).values({
    mockTestId,
    section,
    orderIndex: (maxOrder ?? -1) + 1,
    timeLimitSec,
  });

  res.json({ success: true });
});

// PUT /api/admin/mock-tests/sections/:sectionId/listening-reading  { questionGroupIds }
mockTestsRouter.put("/sections/:sectionId/listening-reading", async (req, res) => {
  const admin = req.user!;
  const parsed = updateListeningReadingContentSchema.safeParse({
    ...req.body,
    sectionId: req.params.sectionId,
  });
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const { sectionId, questionGroupIds } = parsed.data;

  const row = await getOwnedSection(sectionId, admin.organizationId);
  if (!row) return res.status(404).json({ success: false, error: "Section not found." });
  if (row.mockTest.status !== "DRAFT") {
    return res.status(400).json({ success: false, error: "Only draft mock tests can be edited." });
  }
  if (!["LISTENING", "READING"].includes(row.section.section)) {
    return res
      .status(400)
      .json({ success: false, error: "This section doesn't take question groups." });
  }

  // Every referenced group must belong to this org, and match the
  // section's own section+testType (never silently mix, e.g., a Reading
  // group into a Listening section).
  if (questionGroupIds.length > 0) {
    const groups = await db
      .select({
        id: questionGroups.id,
        section: questionGroups.section,
        testType: questionGroups.testType,
      })
      .from(questionGroups)
      .where(eq(questionGroups.organizationId, admin.organizationId));
    const validIds = new Set(
      groups
        .filter((g) => g.section === row.section.section && g.testType === row.mockTest.testType)
        .map((g) => g.id)
    );
    const invalid = questionGroupIds.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      return res.status(400).json({
        success: false,
        error: "One or more selected question groups don't match this section's type.",
      });
    }
  }

  await db.update(mockTestSections).set({ questionGroupIds }).where(eq(mockTestSections.id, sectionId));

  res.json({ success: true });
});

// PUT /api/admin/mock-tests/sections/:sectionId/writing  { tasks }
mockTestsRouter.put("/sections/:sectionId/writing", async (req, res) => {
  const admin = req.user!;
  const parsed = updateWritingContentSchema.safeParse({
    ...req.body,
    sectionId: req.params.sectionId,
  });
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const row = await getOwnedSection(parsed.data.sectionId, admin.organizationId);
  if (!row) return res.status(404).json({ success: false, error: "Section not found." });
  if (row.mockTest.status !== "DRAFT") {
    return res.status(400).json({ success: false, error: "Only draft mock tests can be edited." });
  }

  await db
    .update(mockTestSections)
    .set({ writingTasks: parsed.data.tasks })
    .where(eq(mockTestSections.id, parsed.data.sectionId));

  res.json({ success: true });
});

// PUT /api/admin/mock-tests/sections/:sectionId/speaking  { parts }
mockTestsRouter.put("/sections/:sectionId/speaking", async (req, res) => {
  const admin = req.user!;
  const parsed = updateSpeakingContentSchema.safeParse({
    ...req.body,
    sectionId: req.params.sectionId,
  });
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const row = await getOwnedSection(parsed.data.sectionId, admin.organizationId);
  if (!row) return res.status(404).json({ success: false, error: "Section not found." });
  if (row.mockTest.status !== "DRAFT") {
    return res.status(400).json({ success: false, error: "Only draft mock tests can be edited." });
  }

  await db
    .update(mockTestSections)
    .set({ speakingParts: parsed.data.parts })
    .where(eq(mockTestSections.id, parsed.data.sectionId));

  res.json({ success: true });
});

/**
 * "Do not allow an incomplete mock test to accidentally become available to
 * students." Publish is refused, with specific reasons, unless every section
 * is present and actually has content. Failure: 400 {success:false, error, issues: string[]}.
 */
mockTestsRouter.post("/:mockTestId/publish", async (req, res) => {
  const admin = req.user!;
  const mockTestId = req.params.mockTestId;
  const mockTest = await getOwnedMockTest(mockTestId, admin.organizationId);
  if (!mockTest) {
    return res.status(404).json({
      success: false,
      error: "Mock test not found.",
      issues: ["Mock test not found."],
    });
  }

  const sections = await db
    .select()
    .from(mockTestSections)
    .where(eq(mockTestSections.mockTestId, mockTestId));

  const errors: string[] = [];
  for (const required of REQUIRED_SECTIONS) {
    const section = sections.find((s) => s.section === required);
    if (!section) {
      errors.push(`Missing a ${required} section.`);
      continue;
    }
    if (required === "LISTENING" || required === "READING") {
      if (!section.questionGroupIds || section.questionGroupIds.length === 0) {
        errors.push(`${required} section has no question groups assigned.`);
      } else {
        const grps = await db
          .select()
          .from(questionGroups)
          .where(
            and(
              inArray(questionGroups.id, section.questionGroupIds),
              eq(questionGroups.organizationId, admin.organizationId)
            )
          );
        for (const gid of section.questionGroupIds) {
          const g = grps.find((x) => x.id === gid);
          if (!g) {
            errors.push(`${required} section references a question group that no longer exists.`);
            continue;
          }
          const r = await computeGroupReadiness(g);
          if (!r.ready) {
            const label = g.title || `Part ${g.part}`;
            errors.push(`${required} group "${label}": ${r.issues.join(" ")}`);
          }
        }
      }
    }
    if (required === "WRITING") {
      const tasks = section.writingTasks as unknown[] | null;
      if (!tasks || tasks.length !== 2) {
        errors.push("Writing section needs both tasks configured.");
      }
    }
    if (required === "SPEAKING") {
      const parts = section.speakingParts as unknown[] | null;
      if (!parts || parts.length !== 3) {
        errors.push("Speaking section needs all three parts configured.");
      }
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({ success: false, error: errors.join(" "), issues: errors });
  }

  await db.update(mockTests).set({ status: "PUBLISHED" }).where(eq(mockTests.id, mockTestId));

  await writeAuditLog({
    userId: admin.id,
    action: "MOCK_TEST_PUBLISHED",
    targetType: "mock_test",
    targetId: mockTestId,
  });

  res.json({ success: true });
});

// POST /api/admin/mock-tests/:mockTestId/archive
mockTestsRouter.post("/:mockTestId/archive", async (req, res) => {
  const admin = req.user!;
  const mockTestId = req.params.mockTestId;
  const mockTest = await getOwnedMockTest(mockTestId, admin.organizationId);
  if (!mockTest) return res.status(404).json({ success: false, error: "Mock test not found." });

  await db.update(mockTests).set({ status: "ARCHIVED" }).where(eq(mockTests.id, mockTestId));

  await writeAuditLog({
    userId: admin.id,
    action: "MOCK_TEST_ARCHIVED",
    targetType: "mock_test",
    targetId: mockTestId,
  });

  res.json({ success: true });
});
