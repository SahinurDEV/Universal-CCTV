import "dotenv/config";
import { downloadModel, modelPath } from "../src/lib/detector.js";

const path = modelPath();
console.log(`Downloading object-detection model to ${path} ...`);
downloadModel()
  .then((p) => console.log(`OK: ${p}`))
  .catch((err) => {
    console.error(`Failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
