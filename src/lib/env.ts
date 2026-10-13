import "dotenv/config";
import { z } from "zod";

/**
 * Centralised, validated access to environment variables.
 *
 * Import from here instead of reading `process.env` directly, so a missing
 * or malformed variable fails immediately with a clear message instead of
 * surfacing as a confusing runtime error deep inside a request handler.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AUTH_SECRET: z.string().min(1, "AUTH_SECRET is required"),
  PORT: z.coerce.number().optional().default(4000),
  FRONTEND_ORIGIN: z.string().optional().default("http://localhost:3000"),
  UPLOAD_DIR: z.string().optional().default("./uploads"),
  NODE_ENV: z.string().optional().default("development"),

  // Not required until Phase 7 (AI assessment), but validated now so the
  // shape is fixed early and callers don't need to guess.
  OPENAI_API_KEY: z.string().optional().default(""),
  OPENAI_MODEL: z.string().optional().default("gpt-4.1"),

  // Not required until Phase 6 (Speaking recordings / audio / images).
  STORAGE_ENDPOINT: z.string().optional().default(""),
  STORAGE_REGION: z.string().optional().default("auto"),
  DATABASE_SSL: z.string().optional().default(""),
  STORAGE_BUCKET: z.string().optional().default(""),
  STORAGE_ACCESS_KEY_ID: z.string().optional().default(""),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional().default(""),

  SEED_ORG_NAME: z.string().optional().default("Demo IELTS Training Centre"),
});

/**
 * Neon Object Storage (and `neon env pull`) hands out AWS_* variable names.
 * Accept those as a fallback so the same values work without renaming them.
 * STORAGE_BUCKET has no AWS_* equivalent: it is the bucket's name in the Neon Console.
 */
function withStorageFallbacks(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...source,
    STORAGE_ENDPOINT: source.STORAGE_ENDPOINT || source.AWS_ENDPOINT_URL_S3,
    STORAGE_ACCESS_KEY_ID: source.STORAGE_ACCESS_KEY_ID || source.AWS_ACCESS_KEY_ID,
    STORAGE_SECRET_ACCESS_KEY: source.STORAGE_SECRET_ACCESS_KEY || source.AWS_SECRET_ACCESS_KEY,
    STORAGE_REGION: source.STORAGE_REGION || source.AWS_REGION,
  };
}

function loadEnv() {
  const parsed = envSchema.safeParse(withStorageFallbacks(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration.\n${issues}\n\nCopy .env.example to .env and fill in the required values.`
    );
  }
  return parsed.data;
}

export const env = loadEnv();
