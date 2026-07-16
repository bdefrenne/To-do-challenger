/*
  Create a user account (owner-only; there's no public signup).

  Usage:
    npm run user:create -- <email> <name> <password>

  Example:
    npm run user:create -- alice@example.com "Alice" s3cret-pw

  The name may contain spaces if you quote it. Fails cleanly if the
  email is already taken.
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { createUser } from "../src/lib/db/users";

async function main() {
  const [email, name, password] = process.argv.slice(2);

  if (!email || !name || !password) {
    console.error(
      "Usage: npm run user:create -- <email> <name> <password>\n" +
        'Example: npm run user:create -- alice@example.com "Alice" s3cret-pw',
    );
    process.exit(1);
  }

  try {
    const user = await createUser(email, name, password);
    console.log(`✅ Created user: ${user.name} <${user.email}>`);
    console.log(`   They can now sign in at /login.`);
    process.exit(0);
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  }
}

main();
