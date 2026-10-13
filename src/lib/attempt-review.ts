import { eq, and, inArray, asc } from "drizzle-orm";
import { db } from "@/db";
import {
  mockTestSections,
  questionGroups,
  questions,
  attemptResponses,
} from "@/db/schema";
import { parseBlocks } from "@/lib/question-group-helpers";
import type { QuestionType } from "@/lib/validations/questions";

export type QuestionReviewItem = {
  questionId: string;
  section: "LISTENING" | "READING";
  part: number;
  orderIndex: number;
  questionText: string;
  questionType: QuestionType;
  givenText: string;
  correctText: string;
  isGraded: boolean;
  isCorrect: boolean | null;
};

function optionLabel(options: string[] | undefined, indexes: number[] | undefined) {
  if (!options || !indexes || indexes.length === 0) return "—";
  return indexes.map((i) => options[i] ?? "?").join(", ");
}

function formatAnswer(
  questionType: QuestionType,
  payload: unknown,
  kind: "given" | "correct",
  correctAnswer: Record<string, unknown>,
  groupOptions?: string[]
): string {
  if (kind === "given" && (payload === null || payload === undefined)) {
    return "No answer given";
  }

  switch (questionType) {
    case "MULTIPLE_CHOICE":
    case "MATCHING_HEADINGS": {
      const options = correctAnswer.options as string[] | undefined;
      const indexes =
        kind === "correct"
          ? (correctAnswer.correctOptionIndexes as number[] | undefined)
          : ((payload as { selectedIndexes?: number[] })?.selectedIndexes ?? undefined);
      return optionLabel(options, indexes) || "No answer given";
    }
    case "TRUE_FALSE_NOT_GIVEN":
    case "YES_NO_NOT_GIVEN": {
      const value =
        kind === "correct"
          ? (correctAnswer.correctValue as string | undefined)
          : ((payload as { value?: string })?.value ?? undefined);
      return value ? value.replace("_", " ") : "No answer given";
    }
    case "MATCHING":
    case "MAP_LABELING": {
      const idx =
        kind === "correct"
          ? (correctAnswer.correctOptionIndex as number | undefined)
          : (payload as { selectedIndexes?: number[] })?.selectedIndexes?.[0];
      if (typeof idx !== "number") return "No answer given";
      const letter = String.fromCharCode(65 + idx);
      const text = groupOptions?.[idx];
      return text ? `${letter}. ${text}` : letter;
    }
    case "DIAGRAM_LABELING":
    case "SHORT_ANSWER":
    case "SENTENCE_COMPLETION":
    case "SUMMARY_COMPLETION":
    case "NOTE_COMPLETION":
    case "TABLE_COMPLETION":
    case "FORM_COMPLETION":
    case "FLOW_CHART_COMPLETION": {
      if (kind === "correct") {
        const acceptable = (correctAnswer.acceptableAnswers as string[] | undefined) ?? [];
        return acceptable.join(" / ") || "—";
      }
      const value = (payload as { value?: string })?.value;
      return value && value.trim() ? value : "No answer given";
    }
    default:
      return "—";
  }
}

const AUTO_GRADED_TYPES = new Set<QuestionType>([
  "MULTIPLE_CHOICE",
  "MATCHING_HEADINGS",
  "MATCHING",
  "MAP_LABELING",
  "DIAGRAM_LABELING",
  "TRUE_FALSE_NOT_GIVEN",
  "YES_NO_NOT_GIVEN",
  "SHORT_ANSWER",
  "SENTENCE_COMPLETION",
  "SUMMARY_COMPLETION",
  "NOTE_COMPLETION",
  "TABLE_COMPLETION",
  "FORM_COMPLETION",
  "FLOW_CHART_COMPLETION",
]);

/**
 * Builds a question-by-question review for a submitted attempt's
 * auto-graded sections (Listening/Reading) — the student's answer next
 * to the correct one, for every question, so "automatic grading" means
 * something a student can actually learn from rather than just a number.
 */
export async function loadAttemptQuestionReview(
  mockTestId: string,
  attemptId: string
): Promise<QuestionReviewItem[]> {
  const sections = await db
    .select()
    .from(mockTestSections)
    .where(eq(mockTestSections.mockTestId, mockTestId));

  const relevantSections = sections.filter(
    (s): s is typeof s & { section: "LISTENING" | "READING" } =>
      s.section === "LISTENING" || s.section === "READING"
  );
  if (relevantSections.length === 0) return [];

  const allGroupIds = relevantSections.flatMap((s) => s.questionGroupIds ?? []);
  if (allGroupIds.length === 0) return [];

  const groups = await db
    .select()
    .from(questionGroups)
    .where(inArray(questionGroups.id, allGroupIds));

  const groupQuestions = await db
    .select()
    .from(questions)
    .where(and(inArray(questions.questionGroupId, allGroupIds), eq(questions.status, "PUBLISHED")))
    .orderBy(asc(questions.orderIndex));

  const responses = await db
    .select()
    .from(attemptResponses)
    .where(
      and(
        eq(attemptResponses.attemptId, attemptId),
        inArray(
          attemptResponses.questionId,
          groupQuestions.map((q) => q.id)
        )
      )
    );
  const responseByQuestionId = new Map(responses.map((r) => [r.questionId, r]));

  const items: QuestionReviewItem[] = [];
  for (const section of relevantSections) {
    for (const groupId of section.questionGroupIds ?? []) {
      const group = groups.find((g) => g.id === groupId);
      if (!group) continue;
      const qs = groupQuestions.filter((q) => q.questionGroupId === groupId);
      const optBlock = parseBlocks(group.blocks).find((b) => b.type === "options");
      const groupOptions = optBlock && optBlock.type === "options" ? optBlock.options : undefined;
      for (const q of qs) {
        const correctAnswer = q.correctAnswer as Record<string, unknown>;
        const response = responseByQuestionId.get(q.id);
        const isGraded = AUTO_GRADED_TYPES.has(q.questionType);
        items.push({
          questionId: q.id,
          section: section.section,
          part: group.part,
          orderIndex: q.orderIndex,
          questionText: q.questionText,
          questionType: q.questionType,
          givenText: isGraded
            ? formatAnswer(q.questionType, response?.response ?? null, "given", correctAnswer, groupOptions)
            : "—",
          correctText: isGraded
            ? formatAnswer(q.questionType, null, "correct", correctAnswer, groupOptions)
            : "Not auto-graded",
          isGraded,
          isCorrect: response?.isCorrect === null || response?.isCorrect === undefined
            ? null
            : response.isCorrect === "true",
        });
      }
    }
  }

  return items;
}
