import { writeFile, mkdir, readFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { env } from "@/lib/env";

/**
 * Every call site in the app talks to this interface, never to the
 * filesystem or an S3 SDK directly. Phase 2 ships a local-disk
 * implementation because no object-storage credentials exist yet
 * (§3/§18 call for R2/S3/Supabase Storage, wired up in Phase 6 once
 * Speaking recordings need it too). Swapping the adapter later means
 * changing this file only — no call site changes.
 *
 * NOTE for production: local disk storage does not survive across
 * multiple server instances or ephemeral deploys. This is fine for
 * single-instance local/dev use only. Do not ship Phase 2's adapter to
 * a multi-instance production deployment — swap to the R2/S3 adapter
 * first (Phase 6).
 */
export interface StorageAdapter {
  /** Saves a file, returns the storageKey to persist in the database. */
  save(params: {
    buffer: Buffer;
    originalFilename: string;
    folder: string;
  }): Promise<string>;
  /** Resolves a storageKey to a URL the browser can fetch. */
  getUrl(storageKey: string): string;
  /** Reads a stored file back into memory — used server-side to hand a
   *  Speaking recording's bytes to the transcription API. */
  readBuffer(storageKey: string): Promise<Buffer>;
}

const UPLOAD_ROOT = path.resolve(process.cwd(), env.UPLOAD_DIR);

/** Without a Content-Type the bucket serves files as application/octet-stream, which can break audio/image playback. */
const CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp4": "audio/mp4",
  ".ogg": "audio/ogg", ".webm": "audio/webm", ".aac": "audio/aac",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml",
};
export function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

class LocalDiskStorageAdapter implements StorageAdapter {
  async save(params: {
    buffer: Buffer;
    originalFilename: string;
    folder: string;
  }): Promise<string> {
    const ext = path.extname(params.originalFilename) || "";
    const safeName = `${randomUUID()}${ext}`;
    const dir = path.join(UPLOAD_ROOT, params.folder);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, safeName), params.buffer);
    return `${params.folder}/${safeName}`;
  }

  getUrl(storageKey: string): string {
    return `/uploads/${storageKey}`;
  }

  async readBuffer(storageKey: string): Promise<Buffer> {
    return readFile(path.join(UPLOAD_ROOT, storageKey));
  }
}

/**
 * S3-compatible adapter (Neon Object Storage, Cloudflare R2, AWS S3, Backblaze B2, ...). Used
 * automatically when STORAGE_BUCKET + keys are set. REQUIRED on hosts with
 * an ephemeral filesystem (Render's default) — local disk is wiped on every
 * deploy/restart. Files are served back through the API's /uploads/* route,
 * so the stored `/uploads/<key>` URLs the frontend uses keep working.
 */
class S3StorageAdapter implements StorageAdapter {
  readonly client = new S3Client({
    region: env.STORAGE_REGION || "auto",
    endpoint: env.STORAGE_ENDPOINT || undefined,
    forcePathStyle: !!env.STORAGE_ENDPOINT, // Neon Object Storage is path-style only
    // Newer AWS SDKs attach CRC checksums by default, which S3-compatible stores such as
    // Neon may not accept. Only send/verify them when the operation requires it.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
    },
  });

  async save(params: { buffer: Buffer; originalFilename: string; folder: string }): Promise<string> {
    const ext = path.extname(params.originalFilename) || "";
    const key = `${params.folder}/${randomUUID()}${ext}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: env.STORAGE_BUCKET,
        Key: key,
        Body: params.buffer,
        ContentType: contentTypeFor(params.originalFilename),
      })
    );
    return key;
  }

  getUrl(storageKey: string): string {
    return `/uploads/${storageKey}`;
  }

  async readBuffer(storageKey: string): Promise<Buffer> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: env.STORAGE_BUCKET, Key: storageKey }));
    const chunks: Buffer[] = [];
    for await (const chunk of out.Body as Readable) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  /** Streams an object (with HTTP Range support so audio can seek). */
  async open(storageKey: string, range?: string) {
    return this.client.send(
      new GetObjectCommand({ Bucket: env.STORAGE_BUCKET, Key: storageKey, Range: range })
    );
  }
}

export const isS3Configured =
  !!env.STORAGE_BUCKET && !!env.STORAGE_ACCESS_KEY_ID && !!env.STORAGE_SECRET_ACCESS_KEY;

export const s3Storage = isS3Configured ? new S3StorageAdapter() : null;

export const storage: StorageAdapter = s3Storage ?? new LocalDiskStorageAdapter();
