import { z } from "zod";
import { TEST_TYPES, SECTIONS } from "./question-groups";

export const createMockTestSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  testType: z.enum(TEST_TYPES),
});
export type CreateMockTestInput = z.infer<typeof createMockTestSchema>;

export const addSectionSchema = z.object({
  mockTestId: z.string().uuid(),
  section: z.enum(SECTIONS),
  timeLimitSec: z.number().int().min(60).max(14400),
});
export type AddSectionInput = z.infer<typeof addSectionSchema>;

export const updateListeningReadingContentSchema = z.object({
  sectionId: z.string().uuid(),
  questionGroupIds: z.array(z.string().uuid()),
});
export type UpdateListeningReadingContentInput = z.infer<
  typeof updateListeningReadingContentSchema
>;

const writingTaskSchema = z.object({
  taskNumber: z.union([z.literal(1), z.literal(2)]),
  prompt: z.string().trim().min(1, "Prompt is required"),
  imageDescription: z.string().trim().max(500).optional(),
});
export const updateWritingContentSchema = z.object({
  sectionId: z.string().uuid(),
  tasks: z.array(writingTaskSchema).length(2, "Writing needs exactly two tasks"),
});
export type UpdateWritingContentInput = z.infer<typeof updateWritingContentSchema>;

const speakingPartSchema = z.object({
  part: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  cueCardTopic: z.string().trim().max(300).optional(),
  cueCardPoints: z.array(z.string().trim().max(200)).optional(),
  prepSeconds: z.number().int().min(0).max(300).optional(),
  speakSeconds: z.number().int().min(30).max(600).optional(),
});
export const updateSpeakingContentSchema = z.object({
  sectionId: z.string().uuid(),
  parts: z.array(speakingPartSchema).length(3, "Speaking needs exactly three parts"),
});
export type UpdateSpeakingContentInput = z.infer<
  typeof updateSpeakingContentSchema
>;
