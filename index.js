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
      const oldCache = JSON.parse(data);

      return Object.fromEntries(
        Object.entries(oldCache).map(([k, v]) => {
          if (typeof v === "string") {
            return [k, v === "skip" ? "skip" : { path: v, archived: false }];
          }
          return [k, v];
        }),
      );
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

async function copyToArchive(sourcePath) {
  const destDir = path.resolve(__dirname, "data", "books");
  await fs.promises.mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, path.basename(sourcePath));

  try {
    await fs.promises.copyFile(sourcePath, destPath);
    console.log(`Archived book to: ${destPath}`);
    return true;
  } catch (err) {
    throw new Error(`Failed to archive ${sourcePath}: ${err.message}`);
  }
}

function getOutputFileNameFromMapping(volumeIdPaths, volumeId) {
  const entry = volumeIdPaths[volumeId];
  if (!entry || entry === "skip") return null;

  const epubPath = entry.path;
  const fileName = path.basename(epubPath, ".epub") + "_annotations.json";
  return path.resolve(__dirname, "data", "annotations", fileName);
}

async function archiveAllCachedBooks(volumeIdPaths) {
  console.log("\nArchiving all books from cache...");
  let archivedCount = 0;
  const totalBooks =
    Object.values(volumeIdPaths).filter((v) => v !== "skip").length;

  for (const [volumeId, entry] of Object.entries(volumeIdPaths)) {
    if (entry === "skip" || entry.archived) continue;

    try {
      await copyToArchive(entry.path);
      entry.archived = true;
      archivedCount++;
      console.log(
        `[${archivedCount}/${totalBooks}] Archived ${
          path.basename(entry.path)
        }`,
      );
    } catch (err) {
      console.error(`Failed to archive ${entry.path}: ${err.message}`);
    }
  }

  return archivedCount;
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
  let volumeIdPaths = await loadCachedPaths();
  const result = {};

  let totalAnnotations = 0;
  let matchedAnnotations = 0;
  const uniqueVolumeIds = new Set();

  try {
    // Process current database annotations
    const rows = await fetchBookmarks(dbFilePath);
    totalAnnotations = rows.length;

    for (const row of rows) {
      const volumeId = row.VolumeID;
      uniqueVolumeIds.add(volumeId);

      if (!volumeIdPaths[volumeId]) {
        try {
          const parsedUrl = new URL(volumeId);
          const decodedPathname = decodeURIComponent(parsedUrl.pathname);
          const fileNameWithExt = path.basename(decodedPathname);
          const targetFileName = fileNameWithExt.replace(
            /(\.kepub)?\.epub$/i,
            "",
          ).trim();

          console.log(`Searching for "${targetFileName}"...`);
          const matches = await searchEpubInCalibre(
            calibrePath,
            targetFileName,
          );

          if (matches.length === 1) {
            volumeIdPaths[volumeId] = { path: matches[0], archived: false };
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
              volumeIdPaths[volumeId] = {
                path: matches[choice - 1],
                archived: false,
              };
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
            volumeIdPaths[volumeId] = {
              path: manualPath.trim(),
              archived: false,
            };
          }
        }
      }

      const cacheEntry = volumeIdPaths[volumeId];
      if (cacheEntry === "skip") {
        console.log(`Skipping annotations for VolumeID ${volumeId}`);
        continue;
      }

      // Process bookmark
      try {
        const annotation = await processBookmark(
          row,
          cacheEntry.path,
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

    // Archive all books from cache (including previous entries)
    const newlyArchived = await archiveAllCachedBooks(volumeIdPaths);
    await saveCachedPaths(volumeIdPaths);

    // Save annotations
    for (const volumeId of Object.keys(result)) {
      const outputFile = getOutputFileNameFromMapping(volumeIdPaths, volumeId);
      if (outputFile) {
        await fs.promises.writeFile(
          outputFile,
          JSON.stringify({ annotations: result[volumeId] }, null, 2),
        );
        console.log(`Annotations saved: ${outputFile}`);
      }
    }

    // Statistics
    const totalBooks = Object.values(volumeIdPaths).filter((v) =>
      v !== "skip"
    ).length;
    const skippedBooks = Object.values(volumeIdPaths).filter((v) =>
      v === "skip"
    ).length;
    const archivedBooks =
      Object.values(volumeIdPaths).filter((v) => v !== "skip" && v.archived)
        .length;

    console.log(`\nFinal Statistics:`);
    console.log(
      `- Processed ${matchedAnnotations}/${totalAnnotations} annotations`,
    );
    console.log(`- Total books in cache: ${totalBooks + skippedBooks}`);
    console.log(`  ├─ Successfully archived: ${archivedBooks}/${totalBooks}`);
    console.log(`  └─ Skipped books: ${skippedBooks}`);
    console.log(`- Newly archived in this session: ${newlyArchived}`);
  } catch (err) {
    console.error(err);
  } finally {
    rl.close();
  }
}

main();
