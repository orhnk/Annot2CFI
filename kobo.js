//kobo.js
const sqlite3 = require("sqlite3");
const path = require("path");
const fs = require("fs").promises;

const copiedVolumes = new Set();

// Function to open the database and fetch bookmarks
async function fetchBookmarks(dbFilePath) {
  return new Promise((resolve, reject) => {
    const dbPath = path.isAbsolute(dbFilePath)
      ? dbFilePath
      : path.resolve(dbFilePath);

    // Open the SQLite database
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        return reject(`Error opening database: ${err.message}`);
      }
    });

    // Query to fetch all entries from the Bookmark table
    const query = "SELECT * FROM Bookmark ORDER BY BookmarkID";

    db.all(query, [], (err, rows) => {
      if (err) {
        return reject(`Error querying Bookmark table: ${err.message}`);
      }
      if (rows.length === 0) {
        return resolve([]);
      }

      resolve(rows);
    });
  });
}

// New function: Copy book to archive directory
async function copyToArchive(sourcePath, destDir = "data/books") {
  try {
    const resolvedDestDir = path.resolve(destDir);
    await fs.mkdir(resolvedDestDir, { recursive: true });

    const filename = path.basename(sourcePath);
    const destPath = path.join(resolvedDestDir, filename);

    await fs.copyFile(sourcePath, destPath);
    console.log(`Archived book to: ${destPath}`);
  } catch (err) {
    throw new Error(`Failed to archive ${sourcePath}: ${err.message}`);
  }
}

// Modified bookmark processor with archiving
async function processBookmark(row, volumePath, searchEpub) {
  const { Text: text, Annotation: annotation } = row;
  const cleanedAnnotation = annotation || "";

  try {
    // Archive book if not already copied
    if (!copiedVolumes.has(volumePath)) {
      await copyToArchive(volumePath);
      copiedVolumes.add(volumePath);
    }

    const cfi = await searchEpub(volumePath, text);
    return {
      value: cfi,
      color: "yellow",
      text,
      note: cleanedAnnotation,
      created: new Date().toISOString(),
      modified: "",
    };
  } catch (err) {
    throw new Error(`Processing failed for ${volumePath}: ${err.message}`);
  }
}

// Rest of the original code remains unchanged
module.exports = {
  fetchBookmarks,
  processBookmark,
};
