import { z } from "zod";

export const branchFormSchema = z.object({
  name: z.string().trim().min(1),
  address: z.string().trim().min(1),
  area: z.string().trim().min(1),
  phone: z.string().optional().default(""),
});

export type BranchFormData = z.infer<typeof branchFormSchema>;
