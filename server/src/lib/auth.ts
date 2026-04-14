import { betterAuth, APIError } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db, schema, count } from "@askdb/shared";

let signupLocked = false;

export async function isSignupLocked(): Promise<boolean> {
  if (signupLocked) return true;
  const [row] = await db.select({ n: count() }).from(schema.user);
  if ((row?.n ?? 0) > 0) {
    signupLocked = true;
    return true;
  }
  return false;
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema,
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  emailAndPassword: {
    enabled: true,
  },
  databaseHooks: {
    user: {
      create: {
        before: async () => {
          if (await isSignupLocked()) {
            throw new APIError("FORBIDDEN", {
              message: "Signup is disabled. An admin account already exists.",
            });
          }
        },
      },
    },
  },
});
