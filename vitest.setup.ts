import { randomBytes } from "crypto";

if (!process.env.LUDASH_ENCRYPTION_KEY) {
  process.env.LUDASH_ENCRYPTION_KEY = randomBytes(32).toString("base64");
}
