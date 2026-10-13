import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";

/**
 * Production bootstrap: creates the organization (if none) and ONE admin
 * account from env vars. Use this instead of db:seed on a real deployment —
 * the seed script creates demo users with a known password.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='long-secret' ADMIN_NAME='Your Name' \
 *   DATABASE_URL=<render external url> npm run db:create-admin
 */
async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME?.trim() || "Administrator";
  if (!email || !password || password.length < 8) {
    throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD (min 8 chars).");
  }

  let [org] = await db.select().from(organizations).limit(1);
  if (!org) {
    [org] = await db
      .insert(organizations)
      .values({ name: process.env.SEED_ORG_NAME ?? "ILEARN Spaces", contactEmail: email })
      .returning();
    console.log(`Created organization: ${org.name}`);
  }

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    console.log("An account with that email already exists - nothing to do.");
    process.exit(0);
  }

  await db.insert(users).values({
    organizationId: org.id,
    email,
    passwordHash: await hashPassword(password),
    role: "ADMIN",
    fullName: name,
  });
  console.log(`Created admin: ${email}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
