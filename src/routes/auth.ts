import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations, users, studentProfiles } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/password";
import { loginSchema, registerSchema } from "@/lib/validations/auth";
import { writeAuditLog } from "@/lib/audit";
import { AUTH_COOKIE, cookieOptions, signToken } from "@/lib/jwt";
import { requireAuth } from "@/middleware/auth";

export const authRouter = Router();

/** POST /api/auth/login  { email, password } -> sets httpOnly cookie, returns { user } */
authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid email or password." });
  const { email, password } = parsed.data;

  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

  const session = {
    id: user.id,
    role: user.role,
    organizationId: user.organizationId,
    email: user.email,
    name: user.fullName,
  };
  res.cookie(AUTH_COOKIE, signToken(session), cookieOptions);
  res.json({ user: session });
});

/** POST /api/auth/logout */
authRouter.post("/logout", (_req, res) => {
  res.clearCookie(AUTH_COOKIE, { path: "/" });
  res.json({ success: true });
});

/** GET /api/auth/me -> { user } (401 if signed out) */
authRouter.get("/me", requireAuth, async (req, res) => {
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, req.user!.organizationId))
    .limit(1);
  res.json({ user: { ...req.user, organizationName: org?.name ?? null } });
});

/**
 * POST /api/auth/register — public self-registration, always STUDENT.
 * Teacher/admin accounts are provisioned by an admin.
 */
authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues[0]?.message ?? "Invalid input",
      issues: parsed.error.flatten(),
    });
  }
  const { fullName, email, password } = parsed.data;
  const normalizedEmail = email.toLowerCase();

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail)).limit(1);
  if (existing) return res.status(409).json({ error: "An account with this email already exists." });

  const [org] = await db.select().from(organizations).limit(1);
  if (!org) {
    return res.status(500).json({ error: "No organization is configured yet. Run the seed script before registering." });
  }

  const passwordHash = await hashPassword(password);
  const newUser = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ organizationId: org.id, email: normalizedEmail, passwordHash, role: "STUDENT", fullName })
      .returning();
    await tx.insert(studentProfiles).values({ userId: user.id });
    return user;
  });

  await writeAuditLog({
    userId: newUser.id,
    action: "USER_REGISTERED",
    targetType: "user",
    targetId: newUser.id,
    metadata: { role: "STUDENT" },
  });
  res.status(201).json({ id: newUser.id, email: newUser.email });
});
