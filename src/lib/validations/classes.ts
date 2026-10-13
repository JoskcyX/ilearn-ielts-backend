import { z } from "zod";

export const createClassSchema = z.object({
  name: z.string().trim().min(2, "Class name is required").max(160),
});
export type CreateClassInput = z.infer<typeof createClassSchema>;

export const addStudentToClassSchema = z.object({
  classId: z.string().uuid(),
  studentEmail: z.string().trim().email("Enter a valid email address"),
});
export type AddStudentToClassInput = z.infer<typeof addStudentToClassSchema>;
