import postgres from "postgres";
import { env } from "./env.js";

let client: ReturnType<typeof postgres> | undefined;

export const database = () => {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is required for long-term memory and durable task state");
  }
  client ??= postgres(env.databaseUrl, {
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return client;
};
