import { z } from "zod";

const ALLOWED_FILE_TYPES = ["pdf", "jpg", "jpeg", "png", "webp", "txt"] as const;

function isNotPast(dateStr: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(dateStr) >= today;
}

export const taskFormSchema = z.object({
  classroomId: z.number({ message: "Choose a classroom" }).int().positive(),
  title: z.string().min(2, "Title must be at least 2 characters").max(200, "Title must be at most 200 characters"),
  description: z.string().max(2000, "Description must be at most 2000 characters").optional().or(z.literal("")),
  instructions: z.string().max(2000, "Instructions must be at most 2000 characters").optional().or(z.literal("")),
  maxScore: z.number().int().min(1, "Must be at least 1").max(10000, "Must be at most 10,000"),
  dueDate: z
    .string()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || isNotPast(v), { message: "Due date cannot be in the past" }),
  taskDate: z.string().optional().or(z.literal("")),
  aiEvaluationEnabled: z.boolean(),
  allowedFileTypes: z.array(z.enum(ALLOWED_FILE_TYPES)).max(10, "Choose at most 10 file types"),
});

export type TaskFormSchema = z.infer<typeof taskFormSchema>;
export { ALLOWED_FILE_TYPES };
