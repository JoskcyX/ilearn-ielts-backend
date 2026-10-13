import { eq, and, asc } from "drizzle-orm";
import { db } from "@/db";
import { aiAssessments, speakingRecordings } from "@/db/schema";
import { storage } from "@/lib/storage";
import {
  isOpenAiConfigured,
  assessWritingTask,
  assessSpeakingTranscript,
  transcribeSpeakingAudio,
} from "@/lib/ai-assessment";

type WritingTaskConfig = { taskNumber: number; prompt: string };
type SpeakingPartConfig = {
  part: number;
  cueCardTopic?: string;
  cueCardPoints?: string[];
};

async function upsertAssessment(params: {
  attemptId: string;
  section: "WRITING" | "SPEAKING";
  taskNumber: number;
  status: "COMPLETE" | "FAILED";
  criteriaScores?: Record<string, number>;
  overallBandX10?: number;
  feedback?: string;
  transcript?: string;
  errorMessage?: string;
  rawModelResponse?: unknown;
}) {
  const [existing] = await db
    .select({ id: aiAssessments.id })
    .from(aiAssessments)
    .where(
      and(
        eq(aiAssessments.attemptId, params.attemptId),
        eq(aiAssessments.section, params.section),
        eq(aiAssessments.taskNumber, params.taskNumber)
      )
    )
    .limit(1);

  const values = {
    status: params.status,
    criteriaScores: params.criteriaScores ?? null,
    overallBandX10: params.overallBandX10 ?? null,
    feedback: params.feedback ?? null,
    transcript: params.transcript ?? null,
    errorMessage: params.errorMessage ?? null,
    rawModelResponse: params.rawModelResponse ?? null,
    completedAt: new Date(),
  };

  if (existing) {
    await db.update(aiAssessments).set(values).where(eq(aiAssessments.id, existing.id));
  } else {
    await db.insert(aiAssessments).values({
      attemptId: params.attemptId,
      section: params.section,
      taskNumber: params.taskNumber,
      ...values,
    });
  }
}

/**
 * Runs the AI assessment pass for a submitted Writing section, if
 * OpenAI is configured. Scores each task independently and averages the
 * two overall bands (rounded to the nearest 0.5) for the section band.
 * Never throws — a failed or unconfigured call just leaves the section
 * "pending_review", same as before this pipeline existed.
 */
export async function runWritingAssessment(params: {
  attemptId: string;
  testType: "ACADEMIC" | "GENERAL_TRAINING";
  tasks: WritingTaskConfig[];
  writingResponses: Record<string, string> | null;
  wordCounts: Record<string, number>;
}): Promise<Record<string, unknown>> {
  const base = { status: "pending_review" as const, wordCounts: params.wordCounts };
  if (!isOpenAiConfigured() || params.tasks.length === 0) return base;

  const taskBandX10: Record<string, number> = {};
  let anySucceeded = false;

  // Tasks are assessed concurrently: the whole submit request has to
  // finish well inside a hosting proxy's timeout (~26s on Netlify).
  await Promise.all(
    params.tasks.map(async (task) => {
      const taskNumber = task.taskNumber === 1 || task.taskNumber === 2 ? task.taskNumber : null;
      if (!taskNumber) return;
      const response = params.writingResponses?.[String(task.taskNumber)] ?? "";

      const result = await assessWritingTask({
        prompt: task.prompt,
        response,
        taskNumber,
        testType: params.testType,
      });

      if (result.success) {
        anySucceeded = true;
        taskBandX10[String(task.taskNumber)] = result.overallBandX10;
        await upsertAssessment({
          attemptId: params.attemptId,
          section: "WRITING",
          taskNumber: task.taskNumber,
          status: "COMPLETE",
          criteriaScores: result.criteria,
          overallBandX10: result.overallBandX10,
          feedback: result.feedback,
          rawModelResponse: result.raw,
        });
      } else {
        await upsertAssessment({
          attemptId: params.attemptId,
          section: "WRITING",
          taskNumber: task.taskNumber,
          status: "FAILED",
          errorMessage: result.error,
        });
      }
    })
  );

  if (!anySucceeded) {
    return { ...base, status: "ai_failed" as const };
  }

  const bands = Object.values(taskBandX10);
  const aiBandX10 = Math.round((bands.reduce((a, b) => a + b, 0) / bands.length / 5)) * 5;

  return {
    status: "ai_assessed" as const,
    wordCounts: params.wordCounts,
    aiBandX10,
    taskBandX10,
  };
}

/**
 * Runs the Speaking pipeline: transcribes every recording (if not
 * already transcribed), then assesses the combined transcript as one
 * holistic Speaking score (how real IELTS Speaking is marked — across
 * the whole test, not per part). With no recordings at all, there is
 * nothing real to score, so this stays "not_available" rather than
 * faking a band — same honesty rule as before this pipeline existed.
 */
export async function runSpeakingAssessment(params: {
  attemptId: string;
  speakingParts: SpeakingPartConfig[];
}): Promise<Record<string, unknown>> {
  const recordings = await db
    .select()
    .from(speakingRecordings)
    .where(eq(speakingRecordings.attemptId, params.attemptId))
    .orderBy(asc(speakingRecordings.part));

  if (recordings.length === 0) return { status: "not_available" };
  if (!isOpenAiConfigured()) return { status: "pending_review" };

  const transcriptByPart: Record<number, string> = {};

  await Promise.all(
    recordings.map(async (recording) => {
      if (recording.transcript) {
        transcriptByPart[recording.part] = recording.transcript;
        return;
      }
      try {
        const buffer = await storage.readBuffer(recording.storageKey);
        const result = await transcribeSpeakingAudio({
          buffer,
          filename: recording.storageKey.split("/").pop() ?? `part-${recording.part}.webm`,
        });
        if (result.success) {
          transcriptByPart[recording.part] = result.transcript;
          await db
            .update(speakingRecordings)
            .set({ transcript: result.transcript })
            .where(eq(speakingRecordings.id, recording.id));
        }
      } catch {
        // Leave this part's transcript missing; the combined transcript
        // below just omits it rather than failing the whole assessment.
      }
    })
  );

  const combinedTranscript = Object.entries(transcriptByPart)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([part, text]) => `Part ${part}: ${text}`)
    .join("\n\n");

  if (!combinedTranscript.trim()) {
    await upsertAssessment({
      attemptId: params.attemptId,
      section: "SPEAKING",
      taskNumber: 0,
      status: "FAILED",
      errorMessage: "No recording could be transcribed.",
    });
    return { status: "ai_failed" };
  }

  const cueCardContext = params.speakingParts
    .map((p) => `Part ${p.part}${p.cueCardTopic ? `: ${p.cueCardTopic}` : ""}${p.cueCardPoints ? ` (${p.cueCardPoints.join("; ")})` : ""}`)
    .join("\n");

  const result = await assessSpeakingTranscript({ transcript: combinedTranscript, cueCardContext });

  if (!result.success) {
    await upsertAssessment({
      attemptId: params.attemptId,
      section: "SPEAKING",
      taskNumber: 0,
      status: "FAILED",
      transcript: combinedTranscript,
      errorMessage: result.error,
    });
    return { status: "ai_failed" };
  }

  await upsertAssessment({
    attemptId: params.attemptId,
    section: "SPEAKING",
    taskNumber: 0,
    status: "COMPLETE",
    criteriaScores: result.criteria,
    overallBandX10: result.overallBandX10,
    feedback: result.feedback,
    transcript: combinedTranscript,
    rawModelResponse: result.raw,
  });

  return { status: "ai_assessed", aiBandX10: result.overallBandX10 };
}
