import type { QuestionType } from "@/lib/validations/questions";

export type StudentFacingQuestion = {
  id: string;
  questionType: QuestionType;
  questionText: string;
  orderIndex: number;
  marks: number;
  /** Present only for MULTIPLE_CHOICE / MATCHING_HEADINGS. */
  options?: string[];
  /** How many options the student must select — never which ones. */
  requiredSelectionCount?: number;
  /** Present only for the fill-blank family, as a word-limit hint. */
  maxWords?: number;
};

/**
 * Strips every answer-revealing field out of a question before it is
 * ever sent to a student's browser. This is the one place that decides
 * what a student is allowed to see about a question while sitting it —
 * never the component layer, so there's a single point of review.
 */
export function sanitizeQuestionForStudent(question: {
  id: string;
  questionType: QuestionType;
  questionText: string;
  orderIndex: number;
  marks: number;
  correctAnswer: unknown;
}): StudentFacingQuestion {
  const base = {
    id: question.id,
    questionType: question.questionType,
    questionText: question.questionText,
    orderIndex: question.orderIndex,
    marks: question.marks,
  };

  switch (question.questionType) {
    case "MULTIPLE_CHOICE":
    case "MATCHING_HEADINGS": {
      const answer = question.correctAnswer as {
        options: string[];
        correctOptionIndexes: number[];
      };
      return {
        ...base,
        options: answer.options,
        requiredSelectionCount: answer.correctOptionIndexes?.length ?? 1,
      };
    }
    case "DIAGRAM_LABELING":
    case "SHORT_ANSWER":
    case "SENTENCE_COMPLETION":
    case "SUMMARY_COMPLETION":
    case "NOTE_COMPLETION":
    case "TABLE_COMPLETION":
    case "FORM_COMPLETION":
    case "FLOW_CHART_COMPLETION": {
      const answer = question.correctAnswer as { maxWords?: number };
      return { ...base, maxWords: answer.maxWords };
    }
    default:
      return base;
  }
}
