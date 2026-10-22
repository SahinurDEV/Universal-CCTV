import "dotenv/config";
import { activeModel, downloadModel, modelPath } from "../src/lib/detector.js";

const path = modelPath();
const m = activeModel();
console.log(`Downloading ${m.name} [${m.license}] to ${path} ...`);
downloadModel()
  .then((p) => console.log(`OK: ${p}`))
  .catch((err) => {
    console.error(`Failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
