import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "path";
import { env } from "@/lib/env";
import { s3Storage } from "@/lib/storage";
import { apiRouter } from "@/routes";
import { errorHandler, notFound } from "@/middleware/error";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1); // behind Render's proxy

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(
    cors({
      origin: env.FRONTEND_ORIGIN.split(",").map((s) => s.trim()),
      credentials: true,
    })
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Uploaded audio / speaking recordings (local-disk storage adapter).
  const s3 = s3Storage;
  if (s3) {
    app.get(/^\/uploads\/(.+)$/, async (req, res) => {
      const key = String((req.params as unknown as string[])[0] ?? "");
      if (!key || key.includes("..")) return res.status(400).end();
      try {
        const out = await s3.open(key, req.headers.range);
        res.status(out.ContentRange ? 206 : 200);
        if (out.ContentType) res.setHeader("Content-Type", out.ContentType);
        if (out.ContentLength !== undefined) res.setHeader("Content-Length", String(out.ContentLength));
        if (out.ContentRange) res.setHeader("Content-Range", out.ContentRange);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Cache-Control", "private, max-age=3600");
        (out.Body as import("stream").Readable).pipe(res);
      } catch {
        res.status(404).end();
      }
    });
  } else {
    app.use("/uploads", express.static(path.resolve(process.cwd(), env.UPLOAD_DIR)));
  }

  app.use("/api", apiRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
