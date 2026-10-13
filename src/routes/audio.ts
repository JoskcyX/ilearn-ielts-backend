import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { audioAssets } from "@/db/schema";
import { requireRole } from "@/middleware/auth";
import { audioMetaSchema } from "@/lib/validations/question-groups";
import { storage } from "@/lib/storage";
import { writeAuditLog } from "@/lib/audit";
import { statusBodySchema } from "./passages";

export const audioRouter = Router();
audioRouter.use(requireRole("ADMIN"));

const ACCEPTED_AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
]);
const MAX_AUDIO_BYTES = 100 * 1024 * 1024; // 100MB

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES } });

// GET /api/admin/audio
audioRouter.get("/", async (req, res) => {
  const admin = req.user!;
  const orgAudio = await db
    .select()
    .from(audioAssets)
    .where(eq(audioAssets.organizationId, admin.organizationId))
    .orderBy(desc(audioAssets.createdAt));
  res.json({ audio: orgAudio });
});

function handleUpload(req: Request, res: Response, next: NextFunction) {
  upload.single("file")(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ success: false, error: "File is too large (max 100MB)." });
    }
    if (err) return next(err);
    next();
  });
}

// POST /api/admin/audio  (multipart: file, title, transcript?)
audioRouter.post("/", handleUpload, async (req, res) => {
  const admin = req.user!;
  const file = req.file;
  if (!file || file.size === 0) {
    return res.status(400).json({ success: false, error: "Choose an audio file to upload." });
  }
  const mime = file.mimetype;
  if (mime && mime !== "application/octet-stream" && !ACCEPTED_AUDIO_TYPES.has(mime)) {
    return res.status(400).json({
      success: false,
      error: `Unsupported file type (${mime || "unknown"}). Use MP3, WAV, AAC, or OGG.`,
    });
  }

  const parsed = audioMetaSchema.safeParse({
    title: req.body?.title,
    transcript: req.body?.transcript || undefined,
  });
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }

  const storageKey = await storage.save({
    buffer: file.buffer,
    originalFilename: file.originalname,
    folder: "audio",
  });

  const [asset] = await db
    .insert(audioAssets)
    .values({
      organizationId: admin.organizationId,
      title: parsed.data.title,
      storageKey,
      transcript: parsed.data.transcript ?? null,
      createdBy: admin.id,
    })
    .returning();

  await writeAuditLog({
    userId: admin.id,
    action: "AUDIO_UPLOADED",
    targetType: "audio_asset",
    targetId: asset.id,
    metadata: { originalFilename: file.originalname, bytes: file.size },
  });

  res.json({ success: true });
});

// PATCH /api/admin/audio/:id/status  { status }
audioRouter.patch("/:id/status", async (req, res) => {
  const admin = req.user!;
  const parsed = statusBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid status" });
  const { status } = parsed.data;
  const audioId = req.params.id;

  const [existing] = await db
    .select({ id: audioAssets.id })
    .from(audioAssets)
    .where(and(eq(audioAssets.id, audioId), eq(audioAssets.organizationId, admin.organizationId)))
    .limit(1);
  if (!existing) return res.status(404).json({ success: false, error: "Audio asset not found." });

  await db.update(audioAssets).set({ status }).where(eq(audioAssets.id, audioId));

  await writeAuditLog({
    userId: admin.id,
    action: "AUDIO_STATUS_CHANGED",
    targetType: "audio_asset",
    targetId: audioId,
    metadata: { status },
  });

  res.json({ success: true });
});
