import { defineConfig } from "@trigger.dev/sdk/v3";

// Trigger.dev v3 config. Replace `project` with your project ref from the
// Trigger.dev dashboard (Settings → it looks like `proj_...`). Tasks live in
// src/trigger and run on Trigger.dev's infrastructure — not Vercel — so they
// aren't bound by Vercel's function timeout.
export default defineConfig({
  project: "proj_jokoakevjzwxelcmplsb",
  dirs: ["./src/trigger"],
  // Generous ceiling for long psalms; individual tasks can override.
  maxDuration: 3600,
  runtime: "node-22"
});
