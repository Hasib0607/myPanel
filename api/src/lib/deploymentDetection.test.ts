import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectDeploymentFiles, deploymentHasLaravelPublicIndex, findDeploymentAppRoot, findLaravelAppRoot } from "./deploymentDetection.js";

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

test("detectDeploymentFiles infers Vite preview or static serve without start script", () => {
  const withPreview = detectDeploymentFiles(
    ["package.json", "vite.config.ts"],
    JSON.stringify({
      scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
      devDependencies: { vite: "^5.0.0", react: "^18.0.0" }
    }),
    null
  );
  assert.equal(withPreview.detected, "NODEJS");
  assert.match(withPreview.suggestions.startCommand ?? "", /serve -s dist/);
  assert.equal(withPreview.suggestions.processManager, "PM2");

  const previewOnly = detectDeploymentFiles(
    ["package.json", "vite.config.ts"],
    JSON.stringify({
      scripts: { dev: "vite", preview: "vite preview" },
      devDependencies: { vite: "^5.0.0", react: "^18.0.0" }
    }),
    null
  );
  assert.match(previewOnly.suggestions.startCommand ?? "", /preview/);

  const withoutStart = detectDeploymentFiles(
    ["package.json", "vite.config.ts"],
    JSON.stringify({
      scripts: { dev: "vite", build: "vite build" },
      devDependencies: { vite: "^5.0.0", react: "^18.0.0" }
    }),
    null
  );
  assert.equal(withoutStart.detected, "NODEJS");
  assert.match(withoutStart.suggestions.startCommand ?? "", /serve -s dist/);
  assert.equal(withoutStart.suggestions.processManager, "PM2");
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

test("detectDeploymentFiles keeps Python projects out of Laravel APP_KEY flow", () => {
  const pythonWithComposer = detectDeploymentFiles(
    ["requirements.txt", "composer.json", "app"],
    null,
    JSON.stringify({ require: { "laravel/framework": "^11.0" } })
  );

  assert.equal(pythonWithComposer.detected, "PYTHON");
  assert.equal(pythonWithComposer.suggestions.runtime, "PYTHON");
  assert.equal(pythonWithComposer.suggestions.processManager, "SUPERVISOR");
});

test("deploymentHasLaravelPublicIndex distinguishes backend-only Laravel projects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-detection-"));
  try {
    assert.equal(await deploymentHasLaravelPublicIndex(root), false);

    await fs.mkdir(path.join(root, "public"));
    await fs.writeFile(path.join(root, "public", "index.php"), "<?php\n");

    assert.equal(await deploymentHasLaravelPublicIndex(root), true);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("findLaravelAppRoot detects nested Laravel app folders from zip uploads", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-detection-"));
  try {
    const app = path.join(root, "eBitans_Admin_Final");
    await fs.mkdir(path.join(app, "public"), { recursive: true });
    await fs.writeFile(path.join(app, "artisan"), "#!/usr/bin/env php\n");
    await fs.writeFile(path.join(app, "public", "index.php"), "<?php\n");

    assert.equal(await findLaravelAppRoot(root, "."), app);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("findLaravelAppRoot prefers nested Laravel web root over parent artisan without public index", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-detection-"));
  try {
    await fs.writeFile(path.join(root, "artisan"), "#!/usr/bin/env php\n");

    const app = path.join(root, "eBitans_Admin_Final");
    await fs.mkdir(path.join(app, "public"), { recursive: true });
    await fs.writeFile(path.join(app, "artisan"), "#!/usr/bin/env php\n");
    await fs.writeFile(path.join(app, "public", "index.php"), "<?php\n");

    assert.equal(await findLaravelAppRoot(root, "."), app);
    assert.equal((await findDeploymentAppRoot(root, ".", "LARAVEL"))?.appPath, app);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("findLaravelAppRoot recursively detects deeply nested Laravel public web root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-detection-"));
  try {
    await fs.writeFile(path.join(root, "artisan"), "#!/usr/bin/env php\n");
    const app = path.join(root, "uploaded-source", "release", "eBitans_Admin_Final");
    await fs.mkdir(path.join(app, "public"), { recursive: true });
    await fs.writeFile(path.join(app, "artisan"), "#!/usr/bin/env php\n");
    await fs.writeFile(path.join(app, "public", "index.php"), "<?php\n");

    assert.equal(await findLaravelAppRoot(root, "."), app);
    assert.equal((await findDeploymentAppRoot(root, ".", "LARAVEL"))?.appPath, app);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("findLaravelAppRoot follows public/index.php markers in repeated nested uploads", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-detection-"));
  try {
    await fs.writeFile(path.join(root, "artisan"), "#!/usr/bin/env php\n");
    const app = path.join(root, "a", "b", "c", "d", "e", "f", "eBitans_Admin_Final");
    await fs.mkdir(path.join(app, "public"), { recursive: true });
    await fs.writeFile(path.join(app, "artisan"), "#!/usr/bin/env php\n");
    await fs.writeFile(path.join(app, "public", "index.php"), "<?php\n");

    assert.equal(await findLaravelAppRoot(root, "."), app);
    assert.equal((await findDeploymentAppRoot(root, ".", "LARAVEL"))?.appPath, app);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("findDeploymentAppRoot detects nested React and Node app folders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-detection-"));
  try {
    const app = path.join(root, "react-admin");
    await fs.mkdir(app, { recursive: true });
    await fs.writeFile(path.join(app, "package.json"), JSON.stringify({
      scripts: { build: "vite build" },
      dependencies: { react: "^18.0.0", vite: "^5.0.0" }
    }));
    await fs.writeFile(path.join(app, "vite.config.ts"), "export default {}\n");

    const detected = await findDeploymentAppRoot(root, ".", "NODEJS");
    assert.equal(detected?.appPath, app);
    assert.equal(detected?.detection.detected, "NODEJS");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("findDeploymentAppRoot detects nested Next, Python, and Go app folders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-detection-"));
  try {
    const nextApp = path.join(root, "next-storefront");
    await fs.mkdir(nextApp, { recursive: true });
    await fs.writeFile(path.join(nextApp, "package.json"), JSON.stringify({
      scripts: { build: "next build" },
      dependencies: { next: "^14.0.0", react: "^18.0.0" }
    }));
    assert.equal((await findDeploymentAppRoot(root, ".", "NEXTJS"))?.appPath, nextApp);

    await fs.rm(nextApp, { force: true, recursive: true });
    const pythonApp = path.join(root, "python-api");
    await fs.mkdir(pythonApp, { recursive: true });
    await fs.writeFile(path.join(pythonApp, "requirements.txt"), "fastapi\nuvicorn\n");
    assert.equal((await findDeploymentAppRoot(root, ".", "PYTHON"))?.appPath, pythonApp);

    await fs.rm(pythonApp, { force: true, recursive: true });
    const goApp = path.join(root, "go-api");
    await fs.mkdir(goApp, { recursive: true });
    await fs.writeFile(path.join(goApp, "go.mod"), "module example.com/app\n");
    assert.equal((await findDeploymentAppRoot(root, ".", "GO"))?.appPath, goApp);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});
