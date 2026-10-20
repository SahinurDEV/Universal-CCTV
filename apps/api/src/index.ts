import "dotenv/config";
import { loadEnv } from "./env.js";
import { createApp } from "./app.js";
import { logger } from "./lib/logger.js";

const env = loadEnv();
const app = createApp();

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "api listening");
});
