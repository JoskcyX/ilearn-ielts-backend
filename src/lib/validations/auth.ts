import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().trim().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Public self-registration is for students only (§5: the public area has
 * Login/Registration; teacher and admin accounts are provisioned by an
 * admin — see lib/validations/admin.ts — not created through this form).
 */
export const registerSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your full name").max(120),
  email: z.string().trim().email("Enter a valid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(72, "Password is too long"),
});
export type RegisterInput = z.infer<typeof registerSchema>;
