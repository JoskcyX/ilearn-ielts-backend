import "dotenv/config";
import { readdir, readFile } from "fs/promises";
import path from "path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "@/lib/env";
import { contentTypeFor, isS3Configured, s3Storage } from "@/lib/storage";

/**
 * One-off: copies everything under UPLOAD_DIR (default ./uploads) into the bucket,
 * keeping the same keys (e.g. speaking-recordings/<uuid>.webm) so existing database
 * rows keep working. Safe to re-run; it overwrites identical keys.
 *
 *   npm run storage:upload-local
 */
async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
  );
  return files.flat();
}

async function main() {
  if (!isS3Configured || !s3Storage) {
    throw new Error("Bucket not configured: set STORAGE_BUCKET (and the endpoint + keys) first.");
  }
  const root = path.resolve(process.cwd(), env.UPLOAD_DIR);
  const files = (await walk(root)).filter((f) => path.basename(f) !== ".gitkeep");
  console.log(`Uploading ${files.length} file(s) from ${root} to bucket "${env.STORAGE_BUCKET}"...`);
  for (const file of files) {
    const key = path.relative(root, file).split(path.sep).join("/");
    await s3Storage.client.send(
      new PutObjectCommand({ Bucket: env.STORAGE_BUCKET, Key: key, Body: await readFile(file), ContentType: contentTypeFor(file) })
    );
    console.log("  uploaded", key);
  }
  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Upload failed:", err);
  process.exit(1);
});
