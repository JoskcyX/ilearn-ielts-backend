import { z } from "zod";

export const QUESTION_TYPES = [
  "MULTIPLE_CHOICE",
  "MATCHING",
  "MATCHING_HEADINGS",
  "FORM_COMPLETION",
  "NOTE_COMPLETION",
  "TABLE_COMPLETION",
  "FLOW_CHART_COMPLETION",
  "SUMMARY_COMPLETION",
  "SENTENCE_COMPLETION",
  "SHORT_ANSWER",
  "TRUE_FALSE_NOT_GIVEN",
  "YES_NO_NOT_GIVEN",
  "DIAGRAM_LABELING",
  "MAP_LABELING",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  MULTIPLE_CHOICE: "Multiple choice",
  MATCHING: "Matching",
  MATCHING_HEADINGS: "Matching headings",
  FORM_COMPLETION: "Form completion",
  NOTE_COMPLETION: "Note completion",
  TABLE_COMPLETION: "Table completion",
  FLOW_CHART_COMPLETION: "Flow-chart completion",
  SUMMARY_COMPLETION: "Summary completion",
  SENTENCE_COMPLETION: "Sentence completion",
  SHORT_ANSWER: "Short answer",
  TRUE_FALSE_NOT_GIVEN: "True / False / Not Given",
  YES_NO_NOT_GIVEN: "Yes / No / Not Given",
  DIAGRAM_LABELING: "Diagram labeling",
  MAP_LABELING: "Map / plan labeling",
};

/**
 * Answer-shape registry, keyed by question type.
 *
 * A type present here gets a real, purpose-built editor (see
 * components/admin/questions/AnswerEditor.tsx) and real validation. A
 * type absent here falls back to a raw-JSON editor in the UI.
 * MATCHING / MAP_LABELING answers index the group's first "options" block;
 * DIAGRAM_LABELING is a fill-blank answer (the diagram is an image block).
 */
export const multipleChoiceAnswerSchema = z.object({
  options: z.array(z.string().trim().min(1)).min(2).max(8),
  correctOptionIndexes: z.array(z.number().int().min(0)).min(1),
});
export type MultipleChoiceAnswer = z.infer<typeof multipleChoiceAnswerSchema>;

export const trueFalseNotGivenAnswerSchema = z.object({
  correctValue: z.enum(["TRUE", "FALSE", "NOT_GIVEN"]),
});
export type TrueFalseNotGivenAnswer = z.infer<
  typeof trueFalseNotGivenAnswerSchema
>;

export const yesNoNotGivenAnswerSchema = z.object({
  correctValue: z.enum(["YES", "NO", "NOT_GIVEN"]),
});
export type YesNoNotGivenAnswer = z.infer<typeof yesNoNotGivenAnswerSchema>;

/**
 * Shared shape for every "fill in the blank" family type: short answer,
 * sentence/summary/note/table/form/flow-chart completion. The checking
 * logic is identical (case-insensitive match against any acceptable
 * string) even though the surrounding instructions/UI differ by type.
 */
export const fillBlankAnswerSchema = z.object({
  acceptableAnswers: z.array(z.string().trim().min(1)).min(1),
  maxWords: z.number().int().positive().max(10).optional(),
});
export type FillBlankAnswer = z.infer<typeof fillBlankAnswerSchema>;

/** MATCHING / MAP_LABELING: index into the group's first "options" block. */
export const optionRefAnswerSchema = z.object({
  correctOptionIndex: z.number().int().min(0).max(25),
});
export type OptionRefAnswer = z.infer<typeof optionRefAnswerSchema>;

export const ANSWER_SCHEMA_BY_TYPE: Partial<
  Record<QuestionType, z.ZodTypeAny>
> = {
  MULTIPLE_CHOICE: multipleChoiceAnswerSchema,
  MATCHING_HEADINGS: multipleChoiceAnswerSchema,
  MATCHING: optionRefAnswerSchema,
  MAP_LABELING: optionRefAnswerSchema,
  DIAGRAM_LABELING: fillBlankAnswerSchema,
  TRUE_FALSE_NOT_GIVEN: trueFalseNotGivenAnswerSchema,
  YES_NO_NOT_GIVEN: yesNoNotGivenAnswerSchema,
  SHORT_ANSWER: fillBlankAnswerSchema,
  SENTENCE_COMPLETION: fillBlankAnswerSchema,
  SUMMARY_COMPLETION: fillBlankAnswerSchema,
  NOTE_COMPLETION: fillBlankAnswerSchema,
  TABLE_COMPLETION: fillBlankAnswerSchema,
  FORM_COMPLETION: fillBlankAnswerSchema,
  FLOW_CHART_COMPLETION: fillBlankAnswerSchema,
};

export function hasSpecializedEditor(type: QuestionType): boolean {
  return type in ANSWER_SCHEMA_BY_TYPE;
}

export const createQuestionSchema = z
  .object({
    questionGroupId: z.string().uuid(),
    questionType: z.enum(QUESTION_TYPES),
    questionText: z.string().trim().min(1, "Question text is required"),
    orderIndex: z.number().int().min(0).default(0),
    marks: z.number().int().min(1).max(10).default(1),
    difficulty: z.string().trim().max(40).optional(),
    skill: z.string().trim().max(80).optional(),
    explanation: z.string().trim().max(2000).optional(),
    // Raw JSON in from the form; shape-checked in the server action
    // against ANSWER_SCHEMA_BY_TYPE (or accepted as-is if the type has
    // no specialized schema yet).
    correctAnswer: z.unknown(),
  })
  .superRefine((data, ctx) => {
    const schema = ANSWER_SCHEMA_BY_TYPE[data.questionType];
    if (schema) {
      const result = schema.safeParse(data.correctAnswer);
      if (!result.success) {
        ctx.addIssue({
          code: "custom",
          path: ["correctAnswer"],
          message: `Invalid answer for ${QUESTION_TYPE_LABELS[data.questionType]}: ${result.error.issues[0]?.message}`,
        });
      }
    }
  });
export type CreateQuestionInput = z.infer<typeof createQuestionSchema>;

/** PUT /questions/:id — every field optional; correctAnswer is re-validated against the (new or existing) type. */
export const updateQuestionSchema = z.object({
  questionType: z.enum(QUESTION_TYPES).optional(),
  questionText: z.string().trim().min(1, "Question text is required").optional(),
  marks: z.number().int().min(1).max(10).optional(),
  difficulty: z.string().trim().max(40).nullable().optional(),
  skill: z.string().trim().max(80).nullable().optional(),
  explanation: z.string().trim().max(2000).nullable().optional(),
  correctAnswer: z.unknown().optional(),
});
export type UpdateQuestionInput = z.infer<typeof updateQuestionSchema>;

/** Validates a correctAnswer for a type; returns an error message or null. */
export function validateAnswerForType(type: QuestionType, answer: unknown): string | null {
  const schema = ANSWER_SCHEMA_BY_TYPE[type];
  if (!schema) return null;
  const r = schema.safeParse(answer);
  return r.success
    ? null
    : `Invalid answer for ${QUESTION_TYPE_LABELS[type]}: ${r.error.issues[0]?.message}`;
}
