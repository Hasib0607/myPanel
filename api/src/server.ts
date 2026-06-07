import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { ensurePanelUploadLimits } from "./lib/ensurePanelUploadLimits.js";

const app = buildApp();

app.listen({ host: "0.0.0.0", port: env.PANEL_PORT }).then(() => {
  void ensurePanelUploadLimits(true);
}).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
