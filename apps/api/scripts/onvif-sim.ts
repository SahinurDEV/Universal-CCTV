/**
 * Run the ONVIF simulator for local demos:
 *   pnpm --filter api onvif:sim            # PTZ on :8000, user admin/admin
 * Add the camera in the app as connector ONVIF, host 127.0.0.1, ONVIF port 8000,
 * with an RTSP URL pointing at rtsp://127.0.0.1:8554/simulated.
 */
import { startOnvifSimulator } from "../src/onvif-sim/server.js";

const port = Number(process.env.ONVIF_SIM_PORT ?? 8000);
const sim = await startOnvifSimulator({
  port,
  host: process.env.ONVIF_SIM_HOST ?? "127.0.0.1",
  username: process.env.ONVIF_SIM_USER ?? "admin",
  password: process.env.ONVIF_SIM_PASS ?? "admin",
  ptz: process.env.ONVIF_SIM_PTZ !== "0",
  audioOutput: process.env.ONVIF_SIM_AUDIO === "1",
});
console.log(`ONVIF simulator listening on ${sim.url} (PTZ ${process.env.ONVIF_SIM_PTZ !== "0" ? "on" : "off"})`);
