const sqlite3 = require("sqlite3");
const path = require("path");

async function fetchBookmarks(dbFilePath) {
  return new Promise((resolve, reject) => {
    const dbPath = path.isAbsolute(dbFilePath)
      ? dbFilePath
      : path.resolve(dbFilePath);
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) return reject(`Error opening database: ${err.message}`);
    });

    db.all("SELECT * FROM Bookmark ORDER BY BookmarkID", [], (err, rows) => {
      if (err) return reject(`Error querying Bookmark table: ${err.message}`);
      resolve(rows || []);
    });
  });
}

async function processBookmark(row, epubPath, searchEpub) {
  const { Text: text, Annotation: annotation } = row;
  const cleanedAnnotation = annotation || "";

  try {
    const cfi = await searchEpub(epubPath, text);
    return {
      value: cfi,
      color: "yellow",
      text,
      note: cleanedAnnotation,
      created: new Date().toISOString(),
      modified: "",
    };
  } catch (err) {
    throw new Error(`Processing failed for ${epubPath}: ${err.message}`);
  }
}

module.exports = {
  fetchBookmarks,
  processBookmark,
};
