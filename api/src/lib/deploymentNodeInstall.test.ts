import test from "node:test";
import assert from "node:assert/strict";
import { detectDeploymentFiles } from "./deploymentDetection.js";

function nodePackage() {
  return JSON.stringify({
    scripts: { build: "vite build" },
    dependencies: { react: "^18.0.0" },
    devDependencies: { vite: "^7.0.0" }
  });
}

test("Node deployment install suggestions include build-time devDependencies", () => {
  const npm = detectDeploymentFiles(["package.json", "package-lock.json"], nodePackage(), null);
  const pnpm = detectDeploymentFiles(["package.json", "pnpm-lock.yaml"], nodePackage(), null);
  const yarn = detectDeploymentFiles(["package.json", "yarn.lock"], nodePackage(), null);

  assert.equal(npm.suggestions.installCommand, "npm install --include=dev --production=false");
  assert.equal(pnpm.suggestions.installCommand, "pnpm install --prod=false");
  assert.equal(yarn.suggestions.installCommand, "yarn install --production=false");
});
