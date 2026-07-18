/*
  Seed the roster with a fixed set of placeholder team members and set each
  one's avatar color. Safe to re-run: existing accounts (matched by email) are
  left as-is except for their color, which is always re-applied.

  Usage:
    npm run team:create

  New accounts get a random password (printed once, below) so you can log in
  and re-link them later. Existing accounts' passwords are untouched.
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { randomBytes } from "node:crypto";
import {
  createUser,
  getUserByEmail,
  updateUserProfile,
} from "../src/lib/db/users";

/** name = display name (avatars + assignee string); email must be unique. */
const ROSTER: { name: string; email: string; color: string }[] = [
  { name: "Ben", email: "ben@decarbony.com", color: "#00E5AE" },
  { name: "Simon", email: "simon@decarbony.com", color: "#0267FF" },
  { name: "Antho", email: "anthony@decarbony.com", color: "#E64189" },
  { name: "Angelo", email: "angelo@decarbony.com", color: "#F88600" },
  { name: "Alex", email: "alex@decarbony.com", color: "#FFD600" },
  { name: "Omer", email: "omer@decarbony.com", color: "#FF0000" },
  { name: "Dav", email: "dav@decarbony.com", color: "#11B1FF" },
];

async function main() {
  for (const { name, email, color } of ROSTER) {
    try {
      const existing = await getUserByEmail(email);
      if (existing) {
        await updateUserProfile(existing.id, { color });
        console.log(`↻ recolored  ${name} <${email}>  ${color}`);
        continue;
      }
      const password = randomBytes(12).toString("base64url");
      const user = await createUser(email, name, password);
      await updateUserProfile(user.id, { color });
      console.log(`✅ created    ${name} <${email}>  ${color}  pw: ${password}`);
    } catch (e) {
      console.error(`❌ ${name} <${email}>: ${(e as Error).message}`);
    }
  }
  process.exit(0);
}

main();
