import { Router } from "express";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  users,
  studentProfiles,
  teacherProfiles,
  classes,
  mockTests,
  mockTestSections,
  attempts,
  bandConversions,
} from "@/db/schema";
import { requireRole } from "@/middleware/auth";
import { createUserSchema, resetPasswordSchema } from "@/lib/validations/admin";
import { hashPassword } from "@/lib/password";
import { writeAuditLog } from "@/lib/audit";
import { loadAttemptQuestionReview } from "@/lib/attempt-review";
import { loadAiAssessments, loadSpeakingRecordings } from "@/lib/ai-assessment-review";

export const adminRouter = Router();
adminRouter.use(requireRole("ADMIN"));

const fail = (error: string) => ({ success: false as const, error });

// ---- Dashboard ----
adminRouter.get("/dashboard", async (req, res) => {
  const admin = req.user!;
  const count = sql<number>`count(*)`.mapWith(Number);
  const [[studentCount], [teacherCount], [classCount], [publishedMockCount]] = await Promise.all([
    db
      .select({ count })
      .from(users)
      .where(and(eq(users.organizationId, admin.organizationId), eq(users.role, "STUDENT"))),
    db
      .select({ count })
      .from(users)
      .where(and(eq(users.organizationId, admin.organizationId), eq(users.role, "TEACHER"))),
    db.select({ count }).from(classes).where(eq(classes.organizationId, admin.organizationId)),
    db
      .select({ count })
      .from(mockTests)
      .where(and(eq(mockTests.organizationId, admin.organizationId), eq(mockTests.status, "PUBLISHED"))),
  ]);
  res.json({
    studentCount: studentCount.count,
    teacherCount: teacherCount.count,
    classCount: classCount.count,
    publishedMockCount: publishedMockCount.count,
  });
});

// ---- Users ----
adminRouter.get("/users", async (req, res) => {
  const admin = req.user!;
  const orgUsers = await db
    .select()
    .from(users)
    .where(eq(users.organizationId, admin.organizationId))
    .orderBy(desc(users.createdAt));
  res.json({
    users: orgUsers.map((u) => ({
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    })),
  });
});

adminRouter.post("/users", async (req, res) => {
  const admin = req.user!;
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail(parsed.error.issues[0]?.message ?? "Invalid input"));
  }
  const { fullName, email, password, role } = parsed.data;
  const normalizedEmail = email.toLowerCase();

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);
  if (existing) {
    return res.status(409).json(fail("An account with this email already exists."));
  }

  const passwordHash = await hashPassword(password);

  const newUser = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        organizationId: admin.organizationId,
        email: normalizedEmail,
        passwordHash,
        role,
        fullName,
      })
      .returning();

    if (role === "STUDENT") {
      await tx.insert(studentProfiles).values({ userId: user.id });
    } else if (role === "TEACHER") {
      await tx.insert(teacherProfiles).values({ userId: user.id });
    }
    return user;
  });

  await writeAuditLog({
    userId: admin.id,
    action: "USER_CREATED_BY_ADMIN",
    targetType: "user",
    targetId: newUser.id,
    metadata: { role, email: normalizedEmail },
  });

  res.json({ success: true });
});

adminRouter.post("/users/reset-password", async (req, res) => {
  const admin = req.user!;
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail(parsed.error.issues[0]?.message ?? "Invalid input"));
  }
  const { userId, newPassword } = parsed.data;

  const [targetUser] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, admin.organizationId)))
    .limit(1);
  if (!targetUser) return res.status(404).json(fail("User not found."));

  const passwordHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));

  await writeAuditLog({
    userId: admin.id,
    action: "PASSWORD_RESET_BY_ADMIN",
    targetType: "user",
    targetId: userId,
  });

  res.json({ success: true });
});

// ---- Band conversions ----
const addRowSchema = z.object({
  section: z.enum(["LISTENING", "READING"]),
  testType: z.enum(["ACADEMIC", "GENERAL_TRAINING"]),
  minRaw: z.number().int().min(0),
  maxRaw: z.number().int().min(0),
  band: z.number().min(1).max(9),
});

adminRouter.get("/band-conversions", async (req, res) => {
  const admin = req.user!;
  const rows = await db
    .select()
    .from(bandConversions)
    .where(eq(bandConversions.organizationId, admin.organizationId))
    .orderBy(asc(bandConversions.section), asc(bandConversions.minRaw));
  res.json({
    rows: rows.map((r) => ({
      id: r.id,
      section: r.section,
      testType: r.testType,
      minRaw: r.minRaw,
      maxRaw: r.maxRaw,
      bandX10: r.bandX10,
    })),
  });
});

adminRouter.post("/band-conversions", async (req, res) => {
  const admin = req.user!;
  const parsed = addRowSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail(parsed.error.issues[0]?.message ?? "Invalid input"));
  }
  if (parsed.data.minRaw > parsed.data.maxRaw) {
    return res.status(400).json(fail("Minimum raw score can't exceed the maximum."));
  }
  await db.insert(bandConversions).values({
    organizationId: admin.organizationId,
    section: parsed.data.section,
    testType: parsed.data.testType,
    minRaw: parsed.data.minRaw,
    maxRaw: parsed.data.maxRaw,
    bandX10: Math.round(parsed.data.band * 10),
  });
  res.json({ success: true });
});

adminRouter.delete("/band-conversions/:id", async (req, res) => {
  const admin = req.user!;
  const id = String(req.params.id);
  if (!z.string().uuid().safeParse(id).success) return res.json({ success: true });
  await db
    .delete(bandConversions)
    .where(and(eq(bandConversions.id, id), eq(bandConversions.organizationId, admin.organizationId)));
  res.json({ success: true });
});

// ---- Results ----
adminRouter.get("/results", async (req, res) => {
  const admin = req.user!;
  const rows = await db
    .select({
      id: attempts.id,
      status: attempts.status,
      startedAt: attempts.startedAt,
      submittedAt: attempts.submittedAt,
      overallBandX10: attempts.overallBandX10,
      mockTestTitle: mockTests.title,
      studentName: users.fullName,
      studentEmail: users.email,
    })
    .from(attempts)
    .innerJoin(mockTests, eq(attempts.mockTestId, mockTests.id))
    .innerJoin(studentProfiles, eq(attempts.studentId, studentProfiles.id))
    .innerJoin(users, eq(studentProfiles.userId, users.id))
    .where(eq(attempts.organizationId, admin.organizationId))
    .orderBy(desc(attempts.startedAt));
  res.json({ rows });
});

adminRouter.get("/results/:attemptId", async (req, res) => {
  const admin = req.user!;
  const attemptId = String(req.params.attemptId);
  if (!z.string().uuid().safeParse(attemptId).success) {
    return res.status(404).json({ error: "Not found" });
  }

  const [attempt] = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.id, attemptId), eq(attempts.organizationId, admin.organizationId)))
    .limit(1);
  if (!attempt) return res.status(404).json({ error: "Not found" });

  const [mockTest] = await db.select().from(mockTests).where(eq(mockTests.id, attempt.mockTestId)).limit(1);
  if (!mockTest) return res.status(404).json({ error: "Not found" });

  const [student] = await db
    .select({ name: users.fullName, email: users.email })
    .from(studentProfiles)
    .innerJoin(users, eq(studentProfiles.userId, users.id))
    .where(eq(studentProfiles.id, attempt.studentId))
    .limit(1);

  const [writingSection] = await db
    .select()
    .from(mockTestSections)
    .where(and(eq(mockTestSections.mockTestId, attempt.mockTestId), eq(mockTestSections.section, "WRITING")))
    .limit(1);
  const writingTasks =
    (writingSection?.writingTasks as Array<{ taskNumber: number; prompt: string }> | null) ?? [];

  const base = {
    mockTestTitle: mockTest.title,
    student: student ?? null,
    attempt: {
      id: attempt.id,
      status: attempt.status,
      scores: attempt.scores,
      overallBandX10: attempt.overallBandX10,
      submittedAt: attempt.submittedAt,
      startedAt: attempt.startedAt,
      writingResponses: attempt.writingResponses,
    },
    writingTasks,
  };

  if (attempt.status !== "SUBMITTED") {
    return res.json({ ...base, reviewItems: [], aiAssessments: [], speakingRecordings: [] });
  }

  const [reviewItems, aiAssessments, speakingRecordings] = await Promise.all([
    loadAttemptQuestionReview(attempt.mockTestId, attemptId),
    loadAiAssessments(attemptId),
    loadSpeakingRecordings(attemptId),
  ]);

  res.json({ ...base, reviewItems, aiAssessments, speakingRecordings });
});
