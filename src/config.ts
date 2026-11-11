import { z } from "zod";

const normalize = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const schema = z.object({
  PORT: z.preprocess(
    (value) => normalize(value) ?? undefined,
    z.coerce.number().int().min(1).max(65535).default(4000),
  ),
  WEB_ORIGIN: z.preprocess(
    (value) => normalize(value) ?? "http://localhost:3000",
    z.string().url(),
  ),
});

export const config = schema.parse(process.env);
