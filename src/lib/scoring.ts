import { eq, and, inArray } from "drizzle-orm";
import { db } from "@/db";
import { bandConversions, questions } from "@/db/schema";
import type { QuestionType } from "@/lib/validations/questions";

/**
 * Auto-grading for the objective question-type families (§ "objective
 * scoring"). Only the types with a registered answer schema
 * (lib/validations/questions.ts) are gradable here; anything else
 * (none currently) is left ungraded — isCorrect stays null rather
 * than guessing, consistent with the no-fake-functionality rule.
 */
export function gradeResponse(
  questionType: QuestionType,
  correctAnswer: unknown,
  response: unknown
): { isCorrect: boolean | null; marksAwarded: number | null } {
  try {
    switch (questionType) {
      case "MULTIPLE_CHOICE":
      case "MATCHING_HEADINGS": {
        const correct = correctAnswer as { correctOptionIndexes: number[] };
        const given = response as { selectedIndexes?: number[] } | null;
        if (!given?.selectedIndexes) return { isCorrect: false, marksAwarded: 0 };
        const correctSet = new Set(correct.correctOptionIndexes);
        const givenSet = new Set(given.selectedIndexes);
        const isCorrect =
          correctSet.size === givenSet.size &&
          [...correctSet].every((i) => givenSet.has(i));
        return { isCorrect, marksAwarded: isCorrect ? 1 : 0 };
      }
      case "TRUE_FALSE_NOT_GIVEN": {
        const correct = correctAnswer as { correctValue: string };
        const given = response as { value?: string } | null;
        const isCorrect = !!given?.value && given.value === correct.correctValue;
        return { isCorrect, marksAwarded: isCorrect ? 1 : 0 };
      }
      case "YES_NO_NOT_GIVEN": {
        const correct = correctAnswer as { correctValue: string };
        const given = response as { value?: string } | null;
        const isCorrect = !!given?.value && given.value === correct.correctValue;
        return { isCorrect, marksAwarded: isCorrect ? 1 : 0 };
      }
      case "MATCHING":
      case "MAP_LABELING": {
        const correct = correctAnswer as { correctOptionIndex: number };
        const given = response as { selectedIndexes?: number[] } | null;
        const sel = given?.selectedIndexes;
        const isCorrect =
          Array.isArray(sel) && sel.length === 1 && sel[0] === correct.correctOptionIndex;
        return { isCorrect, marksAwarded: isCorrect ? 1 : 0 };
      }
      case "DIAGRAM_LABELING":
      case "SHORT_ANSWER":
      case "SENTENCE_COMPLETION":
      case "SUMMARY_COMPLETION":
      case "NOTE_COMPLETION":
      case "TABLE_COMPLETION":
      case "FORM_COMPLETION":
      case "FLOW_CHART_COMPLETION": {
        const correct = correctAnswer as { acceptableAnswers: string[] };
        const given = response as { value?: string } | null;
        const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
        const isCorrect =
          !!given?.value &&
          correct.acceptableAnswers.some((a) => normalize(a) === normalize(given.value!));
        return { isCorrect, marksAwarded: isCorrect ? 1 : 0 };
      }
      default:
        return { isCorrect: null, marksAwarded: null };
    }
  } catch {
    return { isCorrect: null, marksAwarded: null };
  }
}

/**
 * Looks up the admin-configurable raw-score -> band table for this
 * organization/section/testType. Returns null (never a guessed number)
 * if no row covers this raw score — an org that hasn't configured a
 * conversion table for a section simply doesn't get a band for it yet.
 */
export async function convertRawToBand(params: {
  organizationId: string;
  section: "LISTENING" | "READING";
  testType: "ACADEMIC" | "GENERAL_TRAINING";
  raw: number;
}): Promise<number | null> {
  const rows = await db
    .select()
    .from(bandConversions)
    .where(
      and(
        eq(bandConversions.organizationId, params.organizationId),
        eq(bandConversions.section, params.section),
        eq(bandConversions.testType, params.testType)
      )
    );
  const match = rows.find((r) => params.raw >= r.minRaw && params.raw <= r.maxRaw);
  return match ? match.bandX10 / 10 : null;
}

/** Fetches correctAnswer + questionType for a set of question ids, keyed by id. */
export async function loadQuestionAnswerKeys(questionIds: string[]) {
  if (questionIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: questions.id,
      questionType: questions.questionType,
      correctAnswer: questions.correctAnswer,
      marks: questions.marks,
    })
    .from(questions)
    .where(inArray(questions.id, questionIds));
  return new Map(rows.map((r) => [r.id, r]));
}
