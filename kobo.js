//kobo.js
const sqlite3 = require("sqlite3");
const path = require("path");

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

// Function to process a single bookmark
async function processBookmark(row, volumePath, searchEpub) {
  const { VolumeID: volumeId, Text: text, Annotation: annotation } = row;
  const cleanedAnnotation = annotation || "";

  try {
    const cfi = await searchEpub(volumePath, text);
    console.log(`Found CFI for: ${cfi}`);

    // Return the annotation data in the specified JSON format
    return {
      value: cfi,
      color: "yellow", // Default color, can be customized
      text,
      note: cleanedAnnotation,
      created: new Date().toISOString(), // Current date-time in ISO format
      modified: "", // Optional field
    };
  } catch (err) {
    throw new Error(`Error while searching for CFI: ${err.message}`);
  }
}

// Exported functions
module.exports = {
  fetchBookmarks,
  processBookmark,
};
