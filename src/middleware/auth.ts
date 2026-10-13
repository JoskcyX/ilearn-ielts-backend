import type { NextFunction, Request, Response } from "express";
import { AUTH_COOKIE, verifyToken, type AppRole, type SessionUser } from "@/lib/jwt";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

/** Reads the JWT from the httpOnly cookie (or an `Authorization: Bearer` header). */
function extractUser(req: Request): SessionUser | null {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const token = (req.cookies?.[AUTH_COOKIE] as string | undefined) ?? bearer;
  return token ? verifyToken(token) : null;
}

/** 401 if not signed in. Sets `req.user`. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = extractUser(req);
  if (!user) return res.status(401).json({ error: "UNAUTHENTICATED" });
  req.user = user;
  next();
}

/** 401 if not signed in, 403 if the role isn't allowed. Sets `req.user`.
 *  This is the authoritative check — the frontend proxy only redirects for UX. */
export function requireRole(...roles: AppRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = extractUser(req);
    if (!user) return res.status(401).json({ error: "UNAUTHENTICATED" });
    if (!roles.includes(user.role)) return res.status(403).json({ error: "FORBIDDEN" });
    req.user = user;
    next();
  };
}
