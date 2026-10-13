import { Router, type Request, type Response } from "express";
import multer from "multer";
import { eq, and, inArray, asc } from "drizzle-orm";
import { db } from "@/db";
import {
  attempts,
  attemptResponses,
  mockTests,
  mockTestSections,
  questionGroups,
  passages,
  audioAssets,
  questions,
  studentProfiles,
  speakingRecordings,
} from "@/db/schema";
import { requireRole } from "@/middleware/auth";
import { sanitizeQuestionForStudent, type StudentFacingQuestion } from "@/lib/exam-view";
import { parseBlocks, resolveBlocks } from "@/lib/question-group-helpers";
import type { ResolvedBlock } from "@/lib/validations/blocks";
import { loadAttemptQuestionReview } from "@/lib/attempt-review";
import { loadAiAssessments, loadSpeakingRecordings } from "@/lib/ai-assessment-review";
import { gradeResponse, convertRawToBand, loadQuestionAnswerKeys } from "@/lib/scoring";
import { writeAuditLog } from "@/lib/audit";
import { runWritingAssessment, runSpeakingAssessment } from "@/lib/ai-assessment-pipeline";
import { isOpenAiConfigured } from "@/lib/ai-assessment";
import { storage } from "@/lib/storage";

export const examRouter = Router();

const SECTION_ORDER = ["LISTENING", "READING", "WRITING", "SPEAKING"] as const;
const MAX_RECORDING_BYTES = 25 * 1024 * 1024; // Whisper's own file-size ceiling

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_RECORDING_BYTES } });

const student = requireRole("STUDENT");

function fail(res: Response, status: number, error: string) {
  return res.status(status).json({ success: false, error });
}

async function getStudentProfileId(userId: string) {
  const [profile] = await db
    .select({ id: studentProfiles.id })
    .from(studentProfiles)
    .where(eq(studentProfiles.userId, userId))
    .limit(1);
  return profile?.id ?? null;
}

async function getOwnedAttempt(attemptId: string, userId: string) {
  const studentId = await getStudentProfileId(userId);
  if (!studentId) return null;
  const [attempt] = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.id, attemptId), eq(attempts.studentId, studentId)))
    .limit(1);
  return attempt ?? null;
}

/**
 * Starts (or resumes) a practice attempt for a PUBLISHED mock test in the
 * student's own organization. Not gated on class membership (by design).
 */
examRouter.post("/attempts", student, async (req, res) => {
  const user = req.user!;
  const mockTestId = req.body?.mockTestId;
  if (typeof mockTestId !== "string" || !mockTestId) return fail(res, 400, "Missing mock test.");

  const studentId = await getStudentProfileId(user.id);
  if (!studentId) return fail(res, 400, "Student profile not found.");

  const [mockTest] = await db
    .select()
    .from(mockTests)
    .where(
      and(
        eq(mockTests.id, mockTestId),
        eq(mockTests.organizationId, user.organizationId),
        eq(mockTests.status, "PUBLISHED")
      )
    )
    .limit(1);
  if (!mockTest) return fail(res, 400, "This mock test isn't available.");

  // Resume an existing in-progress attempt rather than starting a second one.
  const [existing] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(
        eq(attempts.studentId, studentId),
        eq(attempts.mockTestId, mockTestId),
        eq(attempts.status, "IN_PROGRESS")
      )
    )
    .limit(1);
  if (existing) return res.json({ success: true, attemptId: existing.id });

  const sections = await db.select().from(mockTestSections).where(eq(mockTestSections.mockTestId, mockTestId));

  const ordered = SECTION_ORDER.filter((s) => sections.some((sec) => sec.section === s));
  if (ordered.length === 0) return fail(res, 400, "This mock test has no sections configured.");

  // Server-authoritative schedule: cumulative deadline per section.
  let cursor = Date.now();
  const sectionDeadlines: Record<string, string> = {};
  for (const sectionName of ordered) {
    const section = sections.find((s) => s.section === sectionName)!;
    cursor += section.timeLimitSec * 1000;
    sectionDeadlines[sectionName] = new Date(cursor).toISOString();
  }

  const [attempt] = await db
    .insert(attempts)
    .values({
      organizationId: user.organizationId,
      studentId,
      mockTestId,
      status: "IN_PROGRESS",
      sectionDeadlines,
      currentSection: ordered[0],
    })
    .returning();

  await writeAuditLog({
    userId: user.id,
    action: "ATTEMPT_STARTED",
    targetType: "attempt",
    targetId: attempt.id,
    metadata: { mockTestId },
  });

  res.json({ success: true, attemptId: attempt.id });
});

/** Autosave for a single question's response. */
examRouter.put("/attempts/:id/responses", student, async (req, res) => {
  const user = req.user!;
  const attemptId = req.params.id as string;
  const { questionId, response } = req.body ?? {};
  if (typeof questionId !== "string" || !questionId) return fail(res, 400, "Missing question.");

  const attempt = await getOwnedAttempt(attemptId, user.id);
  if (!attempt) return fail(res, 404, "Attempt not found.");
  if (attempt.status !== "IN_PROGRESS") return fail(res, 400, "This attempt has already been submitted.");

  const [existing] = await db
    .select({ id: attemptResponses.id })
    .from(attemptResponses)
    .where(and(eq(attemptResponses.attemptId, attemptId), eq(attemptResponses.questionId, questionId)))
    .limit(1);

  if (existing) {
    await db
      .update(attemptResponses)
      .set({ response, updatedAt: new Date() })
      .where(eq(attemptResponses.id, existing.id));
  } else {
    await db.insert(attemptResponses).values({ attemptId, questionId, response });
  }

  res.json({ success: true });
});

/** Autosave for a Writing task's response text. */
examRouter.put("/attempts/:id/writing", student, async (req, res) => {
  const user = req.user!;
  const attemptId = req.params.id as string;
  const { taskNumber, text } = req.body ?? {};
  if (typeof taskNumber !== "number" || typeof text !== "string") return fail(res, 400, "Invalid request.");

  const attempt = await getOwnedAttempt(attemptId, user.id);
  if (!attempt) return fail(res, 404, "Attempt not found.");
  if (attempt.status !== "IN_PROGRESS") return fail(res, 400, "This attempt has already been submitted.");

  const next = { ...(attempt.writingResponses ?? {}), [String(taskNumber)]: text };
  await db.update(attempts).set({ writingResponses: next }).where(eq(attempts.id, attemptId));

  res.json({ success: true });
});

/** Moves the attempt on to the next section (or leaves it be at the last one). */
examRouter.post("/attempts/:id/advance", student, async (req, res) => {
  const user = req.user!;
  const attemptId = req.params.id as string;
  const attempt = await getOwnedAttempt(attemptId, user.id);
  if (!attempt) return fail(res, 404, "Attempt not found.");
  if (attempt.status !== "IN_PROGRESS") return fail(res, 400, "This attempt has already been submitted.");

  const configured = Object.keys(attempt.sectionDeadlines) as Array<(typeof SECTION_ORDER)[number]>;
  const ordered = SECTION_ORDER.filter((s) => configured.includes(s));
  const currentIndex = ordered.indexOf(attempt.currentSection as never);
  const next = ordered[currentIndex + 1];

  if (next) {
    await db.update(attempts).set({ currentSection: next }).where(eq(attempts.id, attemptId));
  }

  res.json({ success: true });
});

/**
 * Final submission: grades every auto-gradable response, converts raw
 * section scores to a band via the org's conversion table, and runs the
 * Writing/Speaking AI assessment when configured.
 */
examRouter.post("/attempts/:id/submit", student, async (req, res) => {
  const user = req.user!;
  const attemptId = req.params.id as string;
  const attempt = await getOwnedAttempt(attemptId, user.id);
  if (!attempt) return fail(res, 404, "Attempt not found.");
  if (attempt.status !== "IN_PROGRESS") return fail(res, 400, "This attempt has already been submitted.");

  const [mockTest] = await db.select().from(mockTests).where(eq(mockTests.id, attempt.mockTestId)).limit(1);
  const sections = await db
    .select()
    .from(mockTestSections)
    .where(eq(mockTestSections.mockTestId, attempt.mockTestId));

  const responses = await db.select().from(attemptResponses).where(eq(attemptResponses.attemptId, attemptId));
  const responseByQuestionId = new Map(responses.map((r) => [r.questionId, r]));

  const scores: Record<string, unknown> = {};

  // Writing/Speaking AI assessments run concurrently (after the loop) so the
  // submit request stays inside a hosting proxy's ~26s timeout.
  const aiJobs: Array<Promise<void>> = [];
  for (const section of sections) {
    if (section.section === "LISTENING" || section.section === "READING") {
      const groupIds = section.questionGroupIds ?? [];
      const groups =
        groupIds.length > 0
          ? await db.select({ id: questionGroups.id }).from(questionGroups).where(inArray(questionGroups.id, groupIds))
          : [];
      const sectionQuestions =
        groups.length > 0
          ? await db
              .select({ id: questions.id })
              .from(questions)
              .where(
                inArray(
                  questions.questionGroupId,
                  groups.map((g) => g.id)
                )
              )
          : [];
      const answerKeys = await loadQuestionAnswerKeys(sectionQuestions.map((q) => q.id));

      let raw = 0;
      let maxRaw = 0;
      for (const q of sectionQuestions) {
        const key = answerKeys.get(q.id);
        if (!key) continue;
        maxRaw += key.marks;
        const response = responseByQuestionId.get(q.id);
        const { isCorrect, marksAwarded } = gradeResponse(
          key.questionType,
          key.correctAnswer,
          response?.response ?? null
        );
        if (response) {
          await db
            .update(attemptResponses)
            .set({
              isCorrect: isCorrect === null ? null : String(isCorrect),
              marksAwarded,
            })
            .where(eq(attemptResponses.id, response.id));
        }
        raw += marksAwarded ?? 0;
      }

      const band = await convertRawToBand({
        organizationId: attempt.organizationId,
        section: section.section,
        testType: mockTest.testType,
        raw,
      });
      scores[section.section] = { raw, maxRaw, band };
    } else if (section.section === "WRITING") {
      const tasks = (section.writingTasks as Array<{ taskNumber: number; prompt: string }> | null) ?? [];
      const wordCounts: Record<string, number> = {};
      for (const task of tasks) {
        const text = attempt.writingResponses?.[String(task.taskNumber)] ?? "";
        wordCounts[String(task.taskNumber)] = text.trim() ? text.trim().split(/\s+/).length : 0;
      }
      aiJobs.push(
        runWritingAssessment({
          attemptId,
          testType: mockTest.testType,
          tasks,
          writingResponses: attempt.writingResponses,
          wordCounts,
        }).then((r) => {
          scores.WRITING = r;
        })
      );
    } else {
      const speakingParts =
        (section.speakingParts as Array<{
          part: number;
          cueCardTopic?: string;
          cueCardPoints?: string[];
        }> | null) ?? [];
      aiJobs.push(
        runSpeakingAssessment({ attemptId, speakingParts }).then((r) => {
          scores.SPEAKING = r;
        })
      );
    }
  }
  await Promise.all(aiJobs);

  // Objective `.band`, or AI-assessed `.aiBandX10` (divided back to a plain band).
  // A section with neither doesn't contribute, which keeps allSectionsScored honest.
  const bands = Object.values(scores)
    .map((s) => {
      const section = s as { band?: number | null; aiBandX10?: number };
      if (typeof section.band === "number") return section.band;
      if (typeof section.aiBandX10 === "number") return section.aiBandX10 / 10;
      return null;
    })
    .filter((b): b is number => typeof b === "number");
  const allSectionsScored = Object.keys(scores).length === bands.length;
  const overallBand =
    allSectionsScored && bands.length > 0
      ? Math.round((bands.reduce((a, b) => a + b, 0) / bands.length) * 2) / 2
      : null;

  await db
    .update(attempts)
    .set({
      status: "SUBMITTED",
      submittedAt: new Date(),
      scores,
      overallBandX10: overallBand !== null ? Math.round(overallBand * 10) : null,
    })
    .where(eq(attempts.id, attemptId));

  await writeAuditLog({
    userId: user.id,
    action: "ATTEMPT_SUBMITTED",
    targetType: "attempt",
    targetId: attemptId,
  });

  res.json({ success: true, attemptId });
});

/** Uploads one Speaking cue-card recording (multipart: file, part, durationSec), replacing any earlier take. */
examRouter.post("/attempts/:id/speaking", student, upload.single("file"), async (req, res) => {
  const user = req.user!;
  const attemptId = req.params.id as string;

  const partRaw = req.body?.part;
  if (typeof partRaw !== "string") return fail(res, 400, "Missing attempt or part.");
  const part = Number(partRaw);
  if (!Number.isInteger(part) || part < 1) return fail(res, 400, "Invalid part number.");

  const attempt = await getOwnedAttempt(attemptId, user.id);
  if (!attempt) return fail(res, 404, "Attempt not found.");
  if (attempt.status !== "IN_PROGRESS") return fail(res, 400, "This attempt has already been submitted.");
  if (attempt.currentSection !== "SPEAKING") return fail(res, 400, "This attempt isn't on the Speaking section.");

  const file = req.file;
  if (!file || file.size === 0) return fail(res, 400, "No recording was captured.");
  if (file.size > MAX_RECORDING_BYTES) {
    return fail(res, 400, "Recording is too long (max 25MB — try a shorter take).");
  }
  if (file.mimetype && !file.mimetype.startsWith("audio/")) {
    return fail(res, 400, `Unsupported recording type (${file.mimetype}).`);
  }

  const durationRaw = req.body?.durationSec;
  const durationSec =
    typeof durationRaw === "string" && durationRaw !== "" && Number.isFinite(Number(durationRaw))
      ? Math.round(Number(durationRaw))
      : null;

  const storageKey = await storage.save({
    buffer: file.buffer,
    originalFilename: file.originalname || `part-${part}.webm`,
    folder: "speaking-recordings",
  });

  const [existing] = await db
    .select({ id: speakingRecordings.id })
    .from(speakingRecordings)
    .where(and(eq(speakingRecordings.attemptId, attemptId), eq(speakingRecordings.part, part)))
    .limit(1);

  if (existing) {
    await db
      .update(speakingRecordings)
      .set({ storageKey, durationSec, transcript: null })
      .where(eq(speakingRecordings.id, existing.id));
  } else {
    await db.insert(speakingRecordings).values({ attemptId, part, storageKey, durationSec });
  }

  await writeAuditLog({
    userId: user.id,
    action: "SPEAKING_RECORDING_UPLOADED",
    targetType: "attempt",
    targetId: attemptId,
    metadata: { part, bytes: file.size },
  });

  res.json({ success: true });
});

/**
 * Re-runs the AI assessment for Writing or Speaking on a submitted attempt.
 * Available to the owning student and to staff in the same organization.
 */
examRouter.post(
  "/attempts/:id/rerun-assessment",
  requireRole("STUDENT", "TEACHER", "ADMIN"),
  async (req: Request, res: Response) => {
    const user = req.user!;
    const attemptId = req.params.id as string;
    const section = req.body?.section;
    if (section !== "WRITING" && section !== "SPEAKING") return fail(res, 400, "Invalid section.");

    const [attempt] = await db.select().from(attempts).where(eq(attempts.id, attemptId)).limit(1);
    if (!attempt) return fail(res, 404, "Attempt not found.");

    if (user.role === "STUDENT") {
      const [profile] = await db
        .select({ id: studentProfiles.id })
        .from(studentProfiles)
        .where(eq(studentProfiles.userId, user.id))
        .limit(1);
      if (!profile || attempt.studentId !== profile.id) return fail(res, 404, "Attempt not found.");
    } else if (attempt.organizationId !== user.organizationId) {
      return fail(res, 404, "Attempt not found.");
    }

    if (attempt.status !== "SUBMITTED") return fail(res, 400, "This attempt hasn't been submitted yet.");
    if (!isOpenAiConfigured()) return fail(res, 400, "AI assessment isn't configured on this server yet.");

    const [mockTest] = await db.select().from(mockTests).where(eq(mockTests.id, attempt.mockTestId)).limit(1);
    if (!mockTest) return fail(res, 404, "Mock test not found.");

    const scores = { ...(attempt.scores ?? {}) } as Record<string, unknown>;

    if (section === "WRITING") {
      const [sec] = await db
        .select()
        .from(mockTestSections)
        .where(and(eq(mockTestSections.mockTestId, attempt.mockTestId), eq(mockTestSections.section, "WRITING")))
        .limit(1);
      const allTasks = (sec?.writingTasks as Array<{ taskNumber: number; prompt: string }> | null) ?? [];
      if (allTasks.length === 0) return fail(res, 400, "No Writing tasks are configured.");

      // Retries the whole Writing section so the averaged band doesn't drop a task.
      const existingWriting = (scores.WRITING ?? {}) as { wordCounts?: Record<string, number> };
      scores.WRITING = await runWritingAssessment({
        attemptId,
        testType: mockTest.testType,
        tasks: allTasks,
        writingResponses: attempt.writingResponses,
        wordCounts: existingWriting.wordCounts ?? {},
      });
    } else {
      const [sec] = await db
        .select()
        .from(mockTestSections)
        .where(and(eq(mockTestSections.mockTestId, attempt.mockTestId), eq(mockTestSections.section, "SPEAKING")))
        .limit(1);
      const speakingParts =
        (sec?.speakingParts as Array<{ part: number; cueCardTopic?: string; cueCardPoints?: string[] }> | null) ?? [];
      scores.SPEAKING = await runSpeakingAssessment({ attemptId, speakingParts });
    }

    await db.update(attempts).set({ scores }).where(eq(attempts.id, attemptId));

    res.json({ success: true });
  }
);

type WorkspaceGroup = {
  id: string;
  part: number;
  title: string | null;
  blocks: ResolvedBlock[];
  instructions: string;
  passage: { title: string; bodyHtml: string } | null;
  audio: { storageKey: string } | null;
  questions: StudentFacingQuestion[];
};

async function loadReadingOrListeningData(
  attemptId: string,
  section: typeof mockTestSections.$inferSelect
): Promise<{ groups: WorkspaceGroup[]; initialResponses: Record<string, unknown> }> {
  const groupIds = section.questionGroupIds ?? [];
  if (groupIds.length === 0) return { groups: [], initialResponses: {} };

  const rawGroups = await db
    .select()
    .from(questionGroups)
    .where(inArray(questionGroups.id, groupIds))
    .orderBy(asc(questionGroups.part));

  const passageIds = rawGroups.map((g) => g.passageId).filter((id): id is string => !!id);
  const audioIds = rawGroups.map((g) => g.audioId).filter((id): id is string => !!id);

  const [groupPassages, groupAudio, groupQuestions] = await Promise.all([
    passageIds.length > 0
      ? db.select().from(passages).where(inArray(passages.id, passageIds))
      : Promise.resolve([]),
    audioIds.length > 0
      ? db.select().from(audioAssets).where(inArray(audioAssets.id, audioIds))
      : Promise.resolve([]),
    db
      .select()
      .from(questions)
      .where(and(inArray(questions.questionGroupId, groupIds), eq(questions.status, "PUBLISHED")))
      .orderBy(asc(questions.orderIndex)),
  ]);

  const existingResponses =
    groupQuestions.length > 0
      ? await db
          .select()
          .from(attemptResponses)
          .where(
            and(
              eq(attemptResponses.attemptId, attemptId),
              inArray(
                attemptResponses.questionId,
                groupQuestions.map((q) => q.id)
              )
            )
          )
      : [];
  const initialResponses: Record<string, unknown> = {};
  for (const r of existingResponses) initialResponses[r.questionId] = r.response;

  const resolvedByGroup = new Map<string, ResolvedBlock[]>();
  for (const g of rawGroups) {
    resolvedByGroup.set(g.id, (await resolveBlocks(parseBlocks(g.blocks), g.organizationId)).blocks);
  }

  const groups: WorkspaceGroup[] = rawGroups.map((group) => {
    const passage = groupPassages.find((p) => p.id === group.passageId);
    const audio = groupAudio.find((a) => a.id === group.audioId);
    const groupQs = groupQuestions
      .filter((q) => q.questionGroupId === group.id)
      .map((q) => sanitizeQuestionForStudent(q));

    return {
      id: group.id,
      part: group.part,
      title: group.title ?? null,
      blocks: resolvedByGroup.get(group.id) ?? [],
      instructions: group.instructions,
      passage: passage ? { title: passage.title, bodyHtml: passage.bodyHtml } : null,
      audio: audio ? { storageKey: audio.storageKey } : null,
      questions: groupQs,
    };
  });

  return { groups, initialResponses };
}

/**
 * Everything the exam page needs. Submitted attempt -> results view data;
 * in-progress -> the current section's workspace data (no answer keys).
 */
examRouter.get("/attempts/:id", student, async (req, res) => {
  const user = req.user!;
  const attemptId = req.params.id as string;

  const attempt = await getOwnedAttempt(attemptId, user.id);
  if (!attempt) return res.status(404).json({ error: "Not found" });

  const [mockTest] = await db.select().from(mockTests).where(eq(mockTests.id, attempt.mockTestId)).limit(1);
  if (!mockTest) return res.status(404).json({ error: "Not found" });

  if (attempt.status === "SUBMITTED") {
    const [reviewItems, aiAssessments, speakingRecordings] = await Promise.all([
      loadAttemptQuestionReview(attempt.mockTestId, attemptId),
      loadAiAssessments(attemptId),
      loadSpeakingRecordings(attemptId),
    ]);
    return res.json({
      view: "RESULTS",
      attemptId,
      mockTestTitle: mockTest.title,
      attempt: {
        id: attempt.id,
        scores: attempt.scores,
        overallBandX10: attempt.overallBandX10,
        submittedAt: attempt.submittedAt,
      },
      reviewItems,
      aiAssessments,
      speakingRecordings,
    });
  }

  const sections = await db
    .select()
    .from(mockTestSections)
    .where(eq(mockTestSections.mockTestId, attempt.mockTestId))
    .orderBy(asc(mockTestSections.orderIndex));

  const ordered = SECTION_ORDER.filter((s) => sections.some((sec) => sec.section === s));
  const currentSection = sections.find((s) => s.section === attempt.currentSection);
  if (!currentSection) return res.status(404).json({ error: "Not found" });
  const isLastSection = ordered[ordered.length - 1] === currentSection.section;
  const deadlineIso = attempt.sectionDeadlines[currentSection.section] ?? null;

  if (currentSection.section === "LISTENING" || currentSection.section === "READING") {
    const { groups, initialResponses } = await loadReadingOrListeningData(attemptId, currentSection);
    return res.json({
      view: "READING_LISTENING",
      attemptId,
      mockTestTitle: mockTest.title,
      sectionLabel: currentSection.section,
      deadlineIso,
      isLastSection,
      groups,
      initialResponses,
    });
  }

  const writingTasks =
    (currentSection.writingTasks as Array<{ taskNumber: number; prompt: string }> | null) ?? [];
  const speakingParts =
    (currentSection.speakingParts as Array<{
      part: number;
      cueCardTopic?: string;
      cueCardPoints?: string[];
      prepSeconds?: number;
      speakSeconds?: number;
    }> | null) ?? [];

  const existingRecordings =
    currentSection.section === "SPEAKING" ? await loadSpeakingRecordings(attemptId) : [];
  const speakingRecordingsByPart: Record<number, { url: string }> = {};
  for (const r of existingRecordings) speakingRecordingsByPart[r.part] = { url: r.url };

  res.json({
    view: "WRITING_SPEAKING",
    attemptId,
    mockTestTitle: mockTest.title,
    sectionLabel: currentSection.section,
    deadlineIso,
    isLastSection,
    writingTasks,
    speakingParts,
    writingResponses: attempt.writingResponses,
    speakingRecordings: speakingRecordingsByPart,
  });
});
