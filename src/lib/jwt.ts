import jwt from "jsonwebtoken";
import { env } from "@/lib/env";

export type AppRole = "STUDENT" | "TEACHER" | "ADMIN";

export type SessionUser = {
  id: string;
  role: AppRole;
  organizationId: string;
  email: string;
  name: string;
};

export const AUTH_COOKIE = "ielts_token";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export function signToken(user: SessionUser): string {
  return jwt.sign(user, env.AUTH_SECRET, { expiresIn: MAX_AGE_SECONDS });
}

export function verifyToken(token: string): SessionUser | null {
  try {
    const p = jwt.verify(token, env.AUTH_SECRET) as SessionUser;
    return { id: p.id, role: p.role, organizationId: p.organizationId, email: p.email, name: p.name };
  } catch {
    return null;
  }
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: env.NODE_ENV === "production",
  maxAge: MAX_AGE_SECONDS * 1000,
  path: "/",
};
