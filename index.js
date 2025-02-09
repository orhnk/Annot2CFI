// index.js
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { URL } = require("url");
const { fetchBookmarks, processBookmark } = require("./kobo");
const { searchEpub } = require("./epubSearcher");

const cacheFilePath = path.resolve(
  __dirname,
  "data",
  "cache",
  "volumePathsCache.json",
);
const configPath = path.resolve(__dirname, "data", "config.json");

async function getCalibrePath(rl) {
  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      const data = await fs.promises.readFile(configPath, "utf-8");
      config = JSON.parse(data);
      if (config.calibrePath) return config.calibrePath;
    } catch (e) {
      console.error("Error reading config:", e);
    }
  }

  return new Promise((resolve) => {
    rl.question("Enter your Calibre library path: ", async (calibrePath) => {
      calibrePath = calibrePath.trim();
      if (!calibrePath) {
        console.log("Path required!");
        return resolve(await getCalibrePath(rl));
      }
      config.calibrePath = calibrePath;
      await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
      resolve(calibrePath);
    });
  });
}

async function searchEpubInCalibre(calibrePath, targetFileName) {
  return new Promise((resolve, reject) => {
    const rg = spawn("rg", ["--files", "-g", "*.epub", calibrePath]);
    let data = "";

    rg.stdout.on("data", (chunk) => data += chunk);
    rg.on("close", (code) => {
      if (code === 0 || code === 1) {
        const files = data.split("\n").filter(Boolean);
        const normalizedTarget = targetFileName.toLowerCase().trim();

        const matches = files.filter((file) => {
          const epubBase = path.basename(file, ".epub").toLowerCase().trim();
          return epubBase === normalizedTarget;
        });

        resolve(matches);
      } else {
        reject(new Error("ripgrep failed"));
      }
    });
    rg.on("error", reject);
  });
}

async function loadCachedPaths() {
  if (fs.existsSync(cacheFilePath)) {
    try {
      const data = await fs.promises.readFile(cacheFilePath, "utf-8");
      return JSON.parse(data);
    } catch (e) {
      console.error("Error reading cache:", e);
      return {};
    }
  }
  return {};
}

async function saveCachedPaths(volumeIdPaths) {
  await fs.promises.writeFile(
    cacheFilePath,
    JSON.stringify(volumeIdPaths, null, 2),
  );
}

function getOutputFileNameFromMapping(volumeIdPaths, volumeId) {
  const epubPath = volumeIdPaths[volumeId];
  const fileName = path.basename(epubPath, ".epub") + "_annotations.json";
  return path.resolve(__dirname, "data", "annotations", fileName);
}

async function main() {
  const dbFilePath = process.argv[2];
  if (!dbFilePath) {
    console.error("Usage: node index.js <dbFilePath>");
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const calibrePath = await getCalibrePath(rl);
  const volumeIdPaths = await loadCachedPaths();
  const result = {};

  let totalAnnotations = 0;
  let matchedAnnotations = 0;

  try {
    const rows = await fetchBookmarks(dbFilePath);
    totalAnnotations = rows.length;

    for (const row of rows) {
      const volumeId = row.VolumeID;
      if (!volumeIdPaths[volumeId]) {
        try {
          const parsedUrl = new URL(volumeId);
          const decodedPathname = decodeURIComponent(parsedUrl.pathname);
          const fileNameWithExt = path.basename(decodedPathname);

          const targetFileName = fileNameWithExt
            .replace(/(\.kepub)?\.epub$/i, "")
            .trim();

          console.log(`Searching for "${targetFileName}"...`);

          const matches = await searchEpubInCalibre(
            calibrePath,
            targetFileName,
          );

          if (matches.length === 1) {
            volumeIdPaths[volumeId] = matches[0];
          } else if (matches.length > 1) {
            console.log(`Multiple matches for "${targetFileName}":`);
            matches.forEach((match, i) => console.log(`${i + 1}: ${match}`));
            const choice = parseInt(
              await new Promise((r) =>
                rl.question("Select file (number): ", r)
              ),
              10,
            );
            if (choice >= 1 && choice <= matches.length) {
              volumeIdPaths[volumeId] = matches[choice - 1];
            } else {
              throw new Error("Invalid selection");
            }
          } else {
            throw new Error(`No matches found for "${targetFileName}"`);
          }
        } catch (e) {
          console.log(`Error for VolumeID ${volumeId}: ${e.message}`);
          const response = await new Promise((r) =>
            rl.question(`Skip this book (s) or provide a path (p)? (s/p) `, r)
          );
          const trimmedResponse = response.trim().toLowerCase();
          if (trimmedResponse === "s") {
            volumeIdPaths[volumeId] = "skip";
          } else {
            const manualPath = await new Promise((r) =>
              rl.question(`Enter path for ${volumeId}: `, r)
            );
            volumeIdPaths[volumeId] = manualPath.trim();
          }
        }
      }

      const epubPath = volumeIdPaths[volumeId];
      if (epubPath === "skip") {
        console.log(`Skipping annotations for VolumeID ${volumeId}`);
        continue;
      }

      try {
        const annotation = await processBookmark(
          row,
          epubPath,
          searchEpub,
        );
        if (annotation) {
          (result[volumeId] ??= []).push(annotation);
          matchedAnnotations++;
        }
      } catch (err) {
        console.error(`Error processing bookmark: ${err.message}`);
      }
    }

    await saveCachedPaths(volumeIdPaths);

    for (const volumeId of Object.keys(result)) {
      const outputFile = getOutputFileNameFromMapping(volumeIdPaths, volumeId);
      await fs.promises.writeFile(
        outputFile,
        JSON.stringify({ annotations: result[volumeId] }, null, 2),
      );
      console.log(`Annotations saved: ${outputFile}`);
    }

    console.log(
      `Processed ${matchedAnnotations}/${totalAnnotations} annotations`,
    );
  } catch (err) {
    console.error(err);
  } finally {
    rl.close();
  }
}

main();
