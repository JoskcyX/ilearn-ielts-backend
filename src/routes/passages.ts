import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { passages } from "@/db/schema";
import { requireRole } from "@/middleware/auth";
import { createPassageSchema } from "@/lib/validations/question-groups";
import { writeAuditLog } from "@/lib/audit";

export const passagesRouter = Router();
passagesRouter.use(requireRole("ADMIN"));

export const statusBodySchema = z.object({ status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]) });

// GET /api/admin/passages
passagesRouter.get("/", async (req, res) => {
  const admin = req.user!;
  const orgPassages = await db
    .select()
    .from(passages)
    .where(eq(passages.organizationId, admin.organizationId))
    .orderBy(desc(passages.createdAt));
  res.json({ passages: orgPassages });
});

// POST /api/admin/passages
passagesRouter.post("/", async (req, res) => {
  const admin = req.user!;
  const parsed = createPassageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }

  const [passage] = await db
    .insert(passages)
    .values({
      organizationId: admin.organizationId,
      title: parsed.data.title,
      bodyHtml: parsed.data.bodyHtml,
      testType: parsed.data.testType,
      createdBy: admin.id,
    })
    .returning();

  await writeAuditLog({
    userId: admin.id,
    action: "PASSAGE_CREATED",
    targetType: "passage",
    targetId: passage.id,
  });

  res.json({ success: true });
});

// PATCH /api/admin/passages/:id/status  { status }
passagesRouter.patch("/:id/status", async (req, res) => {
  const admin = req.user!;
  const parsed = statusBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid status" });
  const { status } = parsed.data;
  const passageId = req.params.id;

  const [existing] = await db
    .select({ id: passages.id })
    .from(passages)
    .where(and(eq(passages.id, passageId), eq(passages.organizationId, admin.organizationId)))
    .limit(1);
  if (!existing) return res.status(404).json({ success: false, error: "Passage not found." });

  await db.update(passages).set({ status, updatedAt: new Date() }).where(eq(passages.id, passageId));

  await writeAuditLog({
    userId: admin.id,
    action: "PASSAGE_STATUS_CHANGED",
    targetType: "passage",
    targetId: passageId,
    metadata: { status },
  });

  res.json({ success: true });
});
