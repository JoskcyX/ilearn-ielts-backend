import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import {
  attempts,
  mockTests,
  studentProfiles,
  classMembers,
  classes,
  teacherProfiles,
  users,
  organizations,
} from "@/db/schema";
import { requireRole } from "@/middleware/auth";

export const studentRouter = Router();
studentRouter.use(requireRole("STUDENT"));

/** Dashboard: the student's enrolled classes. */
studentRouter.get("/dashboard", async (req, res) => {
  const user = req.user!;
  const [studentProfile] = await db
    .select()
    .from(studentProfiles)
    .where(eq(studentProfiles.userId, user.id))
    .limit(1);

  const enrolledClasses = studentProfile
    ? await db
        .select({
          classId: classes.id,
          className: classes.name,
          teacherName: users.fullName,
        })
        .from(classMembers)
        .innerJoin(classes, eq(classMembers.classId, classes.id))
        .innerJoin(teacherProfiles, eq(classes.teacherId, teacherProfiles.id))
        .innerJoin(users, eq(teacherProfiles.userId, users.id))
        .where(eq(classMembers.studentId, studentProfile.id))
    : [];

  res.json({ enrolledClasses });
});

/** Published mock tests in the student's own organization. */
studentRouter.get("/tests", async (req, res) => {
  const user = req.user!;
  const tests = await db
    .select()
    .from(mockTests)
    .where(and(eq(mockTests.organizationId, user.organizationId), eq(mockTests.status, "PUBLISHED")));
  res.json({ tests });
});

/** The student's own attempts, newest first. */
studentRouter.get("/history", async (req, res) => {
  const user = req.user!;
  const [studentProfile] = await db
    .select({ id: studentProfiles.id })
    .from(studentProfiles)
    .where(eq(studentProfiles.userId, user.id))
    .limit(1);

  const rows = studentProfile
    ? await db
        .select({
          id: attempts.id,
          status: attempts.status,
          startedAt: attempts.startedAt,
          submittedAt: attempts.submittedAt,
          overallBandX10: attempts.overallBandX10,
          mockTestTitle: mockTests.title,
        })
        .from(attempts)
        .innerJoin(mockTests, eq(attempts.mockTestId, mockTests.id))
        .where(eq(attempts.studentId, studentProfile.id))
        .orderBy(desc(attempts.startedAt))
    : [];

  res.json({ rows });
});

studentRouter.get("/profile", async (req, res) => {
  const user = req.user!;
  const [record] = await db
    .select({
      fullName: users.fullName,
      email: users.email,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
      orgName: organizations.name,
    })
    .from(users)
    .innerJoin(organizations, eq(users.organizationId, organizations.id))
    .where(eq(users.id, user.id))
    .limit(1);

  res.json({ record: record ?? null });
});
