import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { mediaAssets, questionGroups } from "@/db/schema";
import { requireRole } from "@/middleware/auth";
import { storage } from "@/lib/storage";
import { writeAuditLog } from "@/lib/audit";
import { imageIdsOf, parseBlocks } from "@/lib/question-group-helpers";

export const mediaRouter = Router();
mediaRouter.use(requireRole("ADMIN"));

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } });

/** Detects the real image type from magic bytes (never trusts the client mime). SVG is deliberately unsupported. */
function sniffImage(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { mime: "image/png", ext: "png" };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.length >= 6) {
    const h = buf.subarray(0, 6).toString("ascii");
    if (h === "GIF87a" || h === "GIF89a") return { mime: "image/gif", ext: "gif" };
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP")
    return { mime: "image/webp", ext: "webp" };
  return null;
}

function handleUpload(req: Request, res: Response, next: NextFunction) {
  upload.single("file")(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ success: false, error: "Image is too large (max 8MB)." });
    }
    if (err) return next(err);
    next();
  });
}

function toDto(a: typeof mediaAssets.$inferSelect, usedBy: number) {
  return {
    id: a.id,
    title: a.title,
    altText: a.altText,
    url: storage.getUrl(a.storageKey),
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    createdAt: a.createdAt,
    usedBy,
  };
}

async function usageCounts(organizationId: string): Promise<Map<string, number>> {
  const groups = await db
    .select({ blocks: questionGroups.blocks })
    .from(questionGroups)
    .where(eq(questionGroups.organizationId, organizationId));
  const counts = new Map<string, number>();
  for (const g of groups)
    for (const id of imageIdsOf(parseBlocks(g.blocks))) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

// GET /api/admin/media
mediaRouter.get("/", async (req, res) => {
  const admin = req.user!;
  const [rows, counts] = await Promise.all([
    db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.organizationId, admin.organizationId))
      .orderBy(desc(mediaAssets.createdAt)),
    usageCounts(admin.organizationId),
  ]);
  res.json({ images: rows.map((r) => toDto(r, counts.get(r.id) ?? 0)) });
});

// POST /api/admin/media  (multipart: file, title?, altText?)
mediaRouter.post("/", handleUpload, async (req, res) => {
  const admin = req.user!;
  const file = req.file;
  if (!file || file.size === 0) {
    return res.status(400).json({ success: false, error: "Choose an image to upload." });
  }
  const kind = sniffImage(file.buffer);
  if (!kind) {
    return res.status(400).json({ success: false, error: "Unsupported image. Use PNG, JPEG, WebP or GIF (SVG is not allowed)." });
  }
  const rawTitle = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const rawAlt = typeof req.body?.altText === "string" ? req.body.altText.trim() : "";
  const baseName = file.originalname.replace(/\.[^.]*$/, "").trim();
  const title = (rawTitle || baseName || "Image").slice(0, 200);
  const altText = rawAlt ? rawAlt.slice(0, 500) : null;

  const storageKey = await storage.save({
    buffer: file.buffer,
    originalFilename: `image.${kind.ext}`,
    folder: "question-images",
  });

  const [asset] = await db
    .insert(mediaAssets)
    .values({
      organizationId: admin.organizationId,
      title,
      altText,
      storageKey,
      mimeType: kind.mime,
      sizeBytes: file.size,
      createdBy: admin.id,
    })
    .returning();

  await writeAuditLog({
    userId: admin.id,
    action: "MEDIA_UPLOADED",
    targetType: "media_asset",
    targetId: asset.id,
    metadata: { bytes: file.size, mimeType: kind.mime },
  });

  res.json({ success: true, image: toDto(asset, 0) });
});

// DELETE /api/admin/media/:id
mediaRouter.delete("/:id", async (req, res) => {
  const admin = req.user!;
  const id = req.params.id as string;
  const [asset] = await db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, id), eq(mediaAssets.organizationId, admin.organizationId)))
    .limit(1);
  if (!asset) return res.status(404).json({ success: false, error: "Image not found." });

  const used = (await usageCounts(admin.organizationId)).get(id) ?? 0;
  if (used > 0) {
    return res.status(409).json({
      success: false,
      error: `This image is used by ${used} question group${used === 1 ? "" : "s"}. Remove it from those groups first.`,
    });
  }

  await db.delete(mediaAssets).where(eq(mediaAssets.id, id));
  await writeAuditLog({
    userId: admin.id,
    action: "MEDIA_DELETED",
    targetType: "media_asset",
    targetId: id,
  });
  res.json({ success: true });
});
