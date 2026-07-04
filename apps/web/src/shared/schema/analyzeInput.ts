import { z } from "zod";
import { HttpUrlSchema } from "./sourceRef";

// The listing is the unit of input — a URL or pasted text, never "a company".
export const AnalyzeInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: HttpUrlSchema }),
  z.object({ kind: z.literal("text"), text: z.string().min(40).max(50_000) }),
]);
export type AnalyzeInput = z.infer<typeof AnalyzeInputSchema>;
