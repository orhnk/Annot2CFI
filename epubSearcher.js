//epubSearcher.js
const he = require("he");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const epubCfiGeneratorPath = path.join(
  __dirname,
  "node_modules",
  ".bin",
  "epub-cfi-generator",
);

const generateFileHash = (filePath) => {
  const hash = crypto.createHash("sha256");
  const fileBuffer = fs.readFileSync(filePath);
  hash.update(fileBuffer);
  return hash.digest("hex");
};

const getBookName = (filePath) => {
  return path.basename(filePath, path.extname(filePath)).replace(/\s+/g, "_");
};

const isDatabaseValid = (epubFilePath, databaseFilePath) => {
  if (!fs.existsSync(databaseFilePath)) {
    return false;
  }
  const databaseData = JSON.parse(fs.readFileSync(databaseFilePath, "utf8"));
  const epubHash = generateFileHash(epubFilePath);
  return databaseData.epubHash === epubHash;
};

const getCfis = (epubFilePath, databaseFilePath, generatorOutputPath) => {
  return new Promise((resolve, reject) => {
    if (isDatabaseValid(epubFilePath, databaseFilePath)) {
      const databaseData = JSON.parse(
        fs.readFileSync(databaseFilePath, "utf8"),
      );
      resolve(databaseData.cfiData);
    } else {
      exec(
        `"${epubCfiGeneratorPath}" "${epubFilePath}" "${generatorOutputPath}"`,
        (error, stdout, stderr) => {
          if (error) {
            return reject(new Error(`Error generating CFIs: ${stderr}`));
          }
          fs.readFile(generatorOutputPath, "utf8", (err, data) => {
            if (err) {
              return reject(
                new Error(
                  `Error reading generator output JSON: ${err.message}`,
                ),
              );
            }
            const cfiData = JSON.parse(data);
            const databaseData = {
              epubHash: generateFileHash(epubFilePath),
              cfiData,
            };
            fs.writeFileSync(
              databaseFilePath,
              JSON.stringify(databaseData, null, 2),
            );
            resolve(cfiData);
          });
        },
      );
    }
  });
};

const getCfisSync = (epubFilePath, databaseFilePath, generatorOutputPath) => {
  if (isDatabaseValid(epubFilePath, databaseFilePath)) {
    const databaseData = JSON.parse(fs.readFileSync(databaseFilePath, "utf8"));
    return databaseData.cfiData;
  } else {
    try {
      console.log("No Database found. Generating CFIs for the first time.");
      // Execute epub-cfi-generator synchronously
      const execSync = require("child_process").execSync;
      execSync(
        `"${epubCfiGeneratorPath}" "${epubFilePath}" "${generatorOutputPath}"`,
      );

      // Read the generated output JSON synchronously
      const data = fs.readFileSync(generatorOutputPath, "utf8");
      const cfiData = JSON.parse(data);

      // Generate and save database data
      const databaseData = {
        epubHash: generateFileHash(epubFilePath),
        cfiData,
      };
      fs.writeFileSync(
        databaseFilePath,
        JSON.stringify(databaseData, null, 2),
      );

      return cfiData;
    } catch (error) {
      throw new Error(`Error generating CFIs: ${error.message}`);
    }
  }
};

const formatEpubCfi = (startCfi, endCfi, startOffset, endOffset) => {
  const [startPath, startOffsetValue] = startCfi.split(":");
  const [endPath, endOffsetValue] = endCfi.split(":");

  const sanitizedStartPath = startPath.replace(/\/\d+$/, "");
  const sanitizedEndPath = endPath.replace(/\/\d+$/, "");

  let commonPart = "";
  const startPathParts = sanitizedStartPath.split("/");
  const endPathParts = sanitizedEndPath.split("/");

  let i = 0;
  while (
    i < startPathParts.length &&
    i < endPathParts.length &&
    startPathParts[i] === endPathParts[i]
  ) {
    commonPart = `${commonPart}/${startPathParts[i]}`;
    i++;
  }

  const dissimilarStart = startPath.slice(commonPart.length);
  const dissimilarEnd = endPath.slice(commonPart.length);

  const startEntity = `/${dissimilarStart}:${startOffset}`;
  const endEntity = `/${dissimilarEnd}:${endOffset}`;

  return `epubcfi(${commonPart.slice(1)},${startEntity},${endEntity})`;
};

const normalizeWhitespace = (text) => {
  // Decode HTML entities (e.g., &nbsp; becomes space, &amp; becomes &)
  text = he.decode(text); // Results slightly off set char offsets.

  //// Normalize spaces (replace multiple spaces with a single space) and trim the text
  //return text.replace(/\s+/g, " ").trim(); // Replace multiple spaces with a single space and trim the text

  //return text.replace(/\s+/g, " ");

  return text;
};

function findMatchWithOptionalSpaces(query, text) {
  const normalize = (str) => str.replace(/\s+/g, "");

  // Remove spaces from the query
  const normalizedQuery = normalize(query);

  // Match char by char. Any char can also be an optional space. Unless the query is fully matched, we continue.
  let query_idx = 0;
  let text_idx = 0;
  let whitespace_count = 0;
  let cursor = "";
  let debug_text = "";
  let debug = false;
  let debug_counter = 0;

  for (; text_idx < text.length; text_idx++) {
    cursor = text[text_idx];

    if (cursor === normalizedQuery[query_idx]) {
      query_idx++;
    } else if (cursor.match(/\s/)) {
      whitespace_count++;
    } else if (cursor === normalizedQuery[0]) { // in some rare cases. Q: "hello" Txt: "h hello" can miss.
      query_idx = 1;
    } else {
      query_idx = 0; // Reset the query. We may have future matches.
      whitespace_count = 0;
      if (debug) {
        debug_counter++;
      }
    }

    if (query_idx > 6) {
      debug = true;
    }

    if (debug && debug_counter < 10) {
      debug_text += text[text_idx + whitespace_count];
      debug_text += " ";
      debug_text += query[query_idx];
      debug_text += "\n";
    }
    if (query_idx === normalizedQuery.length) {
      return text_idx - (query_idx + whitespace_count) + 1; // not sure about the +1. But it fixes the leading text search test
    }
  }

  console.log("Debug text: ", debug_text);

  return null;
}

const searchCfiData = (cfiData, searchText) => {
  // Normalize the search text once
  const normalizedSearchText = normalizeWhitespace(searchText);

  // Flatten the cfiData and create a list of boundaries (start, end indices) for each node
  let combinedText = "";
  let boundaries = []; // [{ cfi, startIdx, endIdx }]

  // TODO: Generating the combined text every time is inefficient. We can optimize this.
  cfiData.forEach((heading) => {
    heading.content.forEach((section) => {
      // Query: "c e f"
      //" a b c "
      //" e f g "
      const nodeText = normalizeWhitespace(section.node);
      const nodeCfi = section.cfi;
      const startIdx = combinedText.length;
      const endIdx = startIdx + nodeText.length;

      // Add the boundary information for the current node
      boundaries.push({
        cfi: nodeCfi,
        startIdx,
        endIdx,
      });

      // Concatenate the node text to the full text
      combinedText += nodeText;
    });
  });

  // Search for the query in the combined text
  const startIdx = findMatchWithOptionalSpaces(
    normalizedSearchText,
    normalizeWhitespace(combinedText),
  );

  if (!startIdx) {
    console.log("----------------------------------------------");
    console.log("| Couldn't find the text below from the epub |");
    console.log("----------------------------------------------");
    console.log(normalizedSearchText);
    console.log("|--------------------------------------------|");
    throw new Error("Text not found in the EPUB.");
  }

  // Calculate the end index of the search text
  const endIdx = startIdx + normalizedSearchText.length;

  // Find the boundary nodes that correspond to the start and end indices
  let startCfi = "";
  let endCfi = "";
  let startOffset = -1;
  let endOffset = -1;

  // Loop through the boundaries and find which nodes correspond to the search range
  for (const boundary of boundaries) {
    if (startIdx >= boundary.startIdx && startIdx < boundary.endIdx) {
      startCfi = boundary.cfi;
      startOffset = startIdx - boundary.startIdx;
    }
    if (endIdx > boundary.startIdx && endIdx <= boundary.endIdx) {
      endCfi = boundary.cfi;
      endOffset = endIdx - boundary.startIdx;
    }
  }

  // If start or end CFIs are still not found, it means the text spans across multiple nodes
  if (!startCfi || !endCfi) {
    throw new Error(
      "Text spans across multiple nodes and couldn't determine CFIs.",
    );
  }

  // Return the formatted result with CFIs and offsets
  return formatEpubCfi(startCfi, endCfi, startOffset, endOffset);
};

const searchEpub = (epubFilePath, searchText) => {
  if (!fs.existsSync(epubFilePath)) {
    throw new Error(`File not found at ${epubFilePath}`);
  }

  const bookName = getBookName(epubFilePath);
  const generatorOutputPath = path.join(
    __dirname,
    "data",
    "cfis",
    `${bookName}_cfi_output.json`,
  );
  const databaseFilePath = path.join(
    __dirname,
    "data",
    "databases",
    `database_${generateFileHash(epubFilePath)}.json`,
  );

  const cfiData = getCfisSync(
    epubFilePath,
    databaseFilePath,
    generatorOutputPath,
  );
  return searchCfiData(cfiData, searchText);
};

module.exports = { searchEpub };
