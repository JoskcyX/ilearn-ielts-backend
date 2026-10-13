import { z } from "zod";

export const createUserSchema = z.object({
  fullName: z.string().trim().min(2, "Full name is required").max(120),
  email: z.string().trim().email("Enter a valid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(72),
  role: z.enum(["STUDENT", "TEACHER", "ADMIN"]),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const resetPasswordSchema = z.object({
  userId: z.string().uuid(),
  newPassword: z.string().min(8, "Password must be at least 8 characters").max(72),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
