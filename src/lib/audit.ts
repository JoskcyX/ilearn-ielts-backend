import { db } from "@/db";
import { auditLogs } from "@/db/schema";

/**
 * Records a sensitive action for later review (§33 Security — audit logs
 * for sensitive administrative actions). Intentionally fire-and-forget
 * from the caller's perspective but awaited internally: a failure to
 * write an audit log should be logged, not allowed to break the action
 * it was supposed to be auditing.
 */
export async function writeAuditLog(params: {
  userId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await db.insert(auditLogs).values({
      userId: params.userId,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      metadata: params.metadata ?? null,
    });
  } catch (err) {
    console.error("Failed to write audit log", params, err);
  }
}
