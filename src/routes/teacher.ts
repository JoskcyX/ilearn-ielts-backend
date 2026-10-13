import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { teacherProfiles, classes, classMembers, studentProfiles, users } from "@/db/schema";
import { requireRole } from "@/middleware/auth";
import { createClassSchema, addStudentToClassSchema } from "@/lib/validations/classes";
import { writeAuditLog } from "@/lib/audit";

export const teacherRouter = Router();
teacherRouter.use(requireRole("TEACHER"));

const fail = (error: string) => ({ success: false as const, error });

async function getTeacherProfile(userId: string) {
  const [p] = await db.select().from(teacherProfiles).where(eq(teacherProfiles.userId, userId)).limit(1);
  return p;
}

async function listTeacherClasses(teacherProfileId: string | undefined) {
  if (!teacherProfileId) return [];
  return db
    .select({
      id: classes.id,
      name: classes.name,
      createdAt: classes.createdAt,
      studentCount: sql<number>`count(${classMembers.id})`.mapWith(Number),
    })
    .from(classes)
    .leftJoin(classMembers, eq(classMembers.classId, classes.id))
    .where(eq(classes.teacherId, teacherProfileId))
    .groupBy(classes.id)
    .orderBy(classes.createdAt);
}

teacherRouter.get("/dashboard", async (req, res) => {
  const profile = await getTeacherProfile(req.user!.id);
  const teacherClasses = await listTeacherClasses(profile?.id);
  const totalStudents = teacherClasses.reduce((sum, c) => sum + c.studentCount, 0);
  res.json({ classes: teacherClasses, totalStudents });
});

teacherRouter.get("/classes", async (req, res) => {
  const profile = await getTeacherProfile(req.user!.id);
  res.json({ classes: await listTeacherClasses(profile?.id) });
});

teacherRouter.post("/classes", async (req, res) => {
  const user = req.user!;
  const parsed = createClassSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail(parsed.error.issues[0]?.message ?? "Invalid input"));
  }
  const teacherProfile = await getTeacherProfile(user.id);
  if (!teacherProfile) return res.status(400).json(fail("No teacher profile found for this account."));

  const [newClass] = await db
    .insert(classes)
    .values({
      organizationId: user.organizationId,
      name: parsed.data.name,
      teacherId: teacherProfile.id,
    })
    .returning();

  await writeAuditLog({
    userId: user.id,
    action: "CLASS_CREATED",
    targetType: "class",
    targetId: newClass.id,
    metadata: { name: newClass.name },
  });

  res.json({ success: true });
});

teacherRouter.get("/classes/:classId", async (req, res) => {
  const classId = String(req.params.classId);
  if (!z.string().uuid().safeParse(classId).success) return res.status(404).json({ error: "Not found" });

  const teacherProfile = await getTeacherProfile(req.user!.id);
  if (!teacherProfile) return res.status(404).json({ error: "Not found" });

  // Ownership check: a teacher can never view another teacher's class by guessing its id.
  const [targetClass] = await db
    .select()
    .from(classes)
    .where(and(eq(classes.id, classId), eq(classes.teacherId, teacherProfile.id)))
    .limit(1);
  if (!targetClass) return res.status(404).json({ error: "Not found" });

  const students = await db
    .select({
      studentId: studentProfiles.id,
      fullName: users.fullName,
      email: users.email,
      joinedAt: classMembers.joinedAt,
    })
    .from(classMembers)
    .innerJoin(studentProfiles, eq(classMembers.studentId, studentProfiles.id))
    .innerJoin(users, eq(studentProfiles.userId, users.id))
    .where(eq(classMembers.classId, classId))
    .orderBy(classMembers.joinedAt);

  res.json({ class: { id: targetClass.id, name: targetClass.name }, students });
});

teacherRouter.post("/classes/:classId/students", async (req, res) => {
  const user = req.user!;
  const parsed = addStudentToClassSchema.safeParse({ ...req.body, classId: req.params.classId });
  if (!parsed.success) {
    return res.status(400).json(fail(parsed.error.issues[0]?.message ?? "Invalid input"));
  }
  const { classId, studentEmail } = parsed.data;

  const teacherProfile = await getTeacherProfile(user.id);
  if (!teacherProfile) return res.status(400).json(fail("No teacher profile found for this account."));

  const [targetClass] = await db
    .select()
    .from(classes)
    .where(
      and(
        eq(classes.id, classId),
        eq(classes.teacherId, teacherProfile.id),
        eq(classes.organizationId, user.organizationId)
      )
    )
    .limit(1);
  if (!targetClass) return res.status(404).json(fail("Class not found."));

  const [studentUser] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.email, studentEmail.toLowerCase()),
        eq(users.organizationId, user.organizationId),
        eq(users.role, "STUDENT")
      )
    )
    .limit(1);
  if (!studentUser) {
    return res.status(404).json(fail("No student with that email was found in your organization."));
  }

  const [studentProfile] = await db
    .select()
    .from(studentProfiles)
    .where(eq(studentProfiles.userId, studentUser.id))
    .limit(1);
  if (!studentProfile) {
    return res.status(400).json(fail("That account doesn't have a student profile."));
  }

  const [existingMembership] = await db
    .select()
    .from(classMembers)
    .where(and(eq(classMembers.classId, classId), eq(classMembers.studentId, studentProfile.id)))
    .limit(1);
  if (existingMembership) {
    return res.status(409).json(fail("That student is already in this class."));
  }

  await db.insert(classMembers).values({ classId, studentId: studentProfile.id });

  await writeAuditLog({
    userId: user.id,
    action: "STUDENT_ADDED_TO_CLASS",
    targetType: "class",
    targetId: classId,
    metadata: { studentEmail: studentEmail.toLowerCase() },
  });

  res.json({ success: true });
});
