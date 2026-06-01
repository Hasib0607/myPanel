import test from "node:test";
import assert from "node:assert/strict";
import { detectDeploymentFiles } from "./deploymentDetection.js";

test("detectDeploymentFiles prefers React package.json over composer.json", () => {
  const detection = detectDeploymentFiles(
    ["package.json", "composer.json", "vite.config.ts"],
    JSON.stringify({
      scripts: { dev: "vite", build: "vite build", start: "vite preview" },
      dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" },
      devDependencies: { vite: "^5.0.0" }
    }),
    JSON.stringify({
      require: { "some/php-library": "^1.0" }
    })
  );

  assert.equal(detection.detected, "NODEJS");
});

test("detectDeploymentFiles detects Laravel only with artisan or laravel framework", () => {
  const withArtisan = detectDeploymentFiles(["artisan", "composer.json"], null, null);
  assert.equal(withArtisan.detected, "LARAVEL");

  const withLaravelComposer = detectDeploymentFiles(
    ["composer.json"],
    null,
    JSON.stringify({ require: { "laravel/framework": "^11.0" } })
  );
  assert.equal(withLaravelComposer.detected, "LARAVEL");

  const composerOnly = detectDeploymentFiles(
    ["composer.json"],
    null,
    JSON.stringify({ require: { "guzzlehttp/guzzle": "^7.0" } })
  );
  assert.notEqual(composerOnly.detected, "LARAVEL");
});
