import { eq, asc } from "drizzle-orm";
import { db } from "@/db";
import { aiAssessments, speakingRecordings } from "@/db/schema";
import { storage } from "@/lib/storage";

export type AiAssessmentItem = {
  id: string;
  section: "WRITING" | "SPEAKING";
  taskNumber: number;
  status: "PENDING" | "COMPLETE" | "FAILED";
  criteriaScores: Record<string, number> | null;
  overallBandX10: number | null;
  feedback: string | null;
  transcript: string | null;
  errorMessage: string | null;
};

export type SpeakingRecordingItem = {
  id: string;
  part: number;
  url: string;
  durationSec: number | null;
  transcript: string | null;
};

/** Loads every AI assessment row for an attempt, Writing tasks and Speaking alike. */
export async function loadAiAssessments(attemptId: string): Promise<AiAssessmentItem[]> {
  const rows = await db
    .select()
    .from(aiAssessments)
    .where(eq(aiAssessments.attemptId, attemptId))
    .orderBy(asc(aiAssessments.section), asc(aiAssessments.taskNumber));

  return rows.map((r) => ({
    id: r.id,
    section: r.section as "WRITING" | "SPEAKING",
    taskNumber: r.taskNumber,
    status: r.status,
    criteriaScores: r.criteriaScores,
    overallBandX10: r.overallBandX10,
    feedback: r.feedback,
    transcript: r.transcript,
    errorMessage: r.errorMessage,
  }));
}

/** Loads every Speaking recording for an attempt, with a playable URL. */
export async function loadSpeakingRecordings(attemptId: string): Promise<SpeakingRecordingItem[]> {
  const rows = await db
    .select()
    .from(speakingRecordings)
    .where(eq(speakingRecordings.attemptId, attemptId))
    .orderBy(asc(speakingRecordings.part));

  return rows.map((r) => ({
    id: r.id,
    part: r.part,
    url: storage.getUrl(r.storageKey),
    durationSec: r.durationSec,
    transcript: r.transcript,
  }));
}
