import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { classes, classMembers, teacherProfiles, users } from "@/db/schema";
import { requireRole } from "@/middleware/auth";

// Mounted at /api/admin/classes. The original class actions (create / add student)
// are TEACHER-only and live in teacher.ts; admins only get the org-wide read view.
export const classesRouter = Router();
classesRouter.use(requireRole("ADMIN"));

classesRouter.get("/", async (req, res) => {
  const admin = req.user!;
  const orgClasses = await db
    .select({
      id: classes.id,
      name: classes.name,
      teacherName: users.fullName,
      createdAt: classes.createdAt,
      studentCount: sql<number>`count(${classMembers.id})`.mapWith(Number),
    })
    .from(classes)
    .innerJoin(teacherProfiles, eq(classes.teacherId, teacherProfiles.id))
    .innerJoin(users, eq(teacherProfiles.userId, users.id))
    .leftJoin(classMembers, eq(classMembers.classId, classes.id))
    .where(eq(classes.organizationId, admin.organizationId))
    .groupBy(classes.id, users.fullName)
    .orderBy(classes.createdAt);
  res.json({ classes: orgClasses });
});
