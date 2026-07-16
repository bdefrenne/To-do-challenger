import { defineConfig } from "drizzle-kit";
import { loadEnvConfig } from "@next/env";

// Load every .env* file the same way Next.js does in dev (incl. .env.local
// and the .env.development.local that `vercel env pull` writes).
loadEnvConfig(process.cwd(), true);

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
