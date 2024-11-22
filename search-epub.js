const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Retrieve command-line arguments
const [, , epubFilePath, searchText] = process.argv;

if (!epubFilePath || !searchText) {
  console.error("Usage: node searchEpub.js <path_to_epub> <search_text>");
  process.exit(1);
}

if (!fs.existsSync(epubFilePath)) {
  console.error(`Error: File not found at ${epubFilePath}`);
  process.exit(1);
}

const outputJsonPath = path.join(__dirname, "cfi_output.json");
const cacheFilePath = path.join(__dirname, "cfi_cache.json");
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

const isCacheValid = () => {
  if (!fs.existsSync(cacheFilePath)) {
    return false;
  }
  const cacheData = JSON.parse(fs.readFileSync(cacheFilePath, "utf8"));
  const epubHash = generateFileHash(epubFilePath);
  return cacheData.epubHash === epubHash;
};

const getCfis = (callback) => {
  if (isCacheValid()) {
    const cachedData = JSON.parse(fs.readFileSync(cacheFilePath, "utf8"));
    callback(null, cachedData.cfiData);
  } else {
    exec(
      `"${epubCfiGeneratorPath}" "${epubFilePath}" "${outputJsonPath}"`,
      (error, stdout, stderr) => {
        if (error) {
          console.error(`Error generating CFIs: ${stderr}`);
          callback(error);
          return;
        }
        fs.readFile(outputJsonPath, "utf8", (err, data) => {
          if (err) {
            console.error(`Error reading output JSON: ${err.message}`);
            callback(err);
            return;
          }
          const cfiData = JSON.parse(data);
          const cacheData = {
            epubHash: generateFileHash(epubFilePath),
            cfiData,
          };
          fs.writeFileSync(cacheFilePath, JSON.stringify(cacheData, null, 2));
          fs.unlinkSync(outputJsonPath);
          callback(null, cfiData);
        });
      },
    );
  }
};

const normalizeWhitespace = (text) => {
  return text.replace(/\s+/g, " ").trim();
};

const formatEpubCfi = (startCfi, endCfi, startOffset, endOffset) => {
  // Extract the path and offset from both the start and end CFIs
  const [startPath, startOffsetValue] = startCfi.split(":");
  const [endPath, endOffsetValue] = endCfi.split(":");

  // Remove the final segment (last /n) from both paths
  const sanitizedStartPath = startPath.replace(/\/\d+$/, "");
  const sanitizedEndPath = endPath.replace(/\/\d+$/, "");

  // Find the common part of the path
  let commonPart = "";
  const startPathParts = sanitizedStartPath.split("/");
  const endPathParts = sanitizedEndPath.split("/");

  // Loop through both paths and find the common segment
  let i = 0;
  while (
    i < startPathParts.length && i < endPathParts.length &&
    startPathParts[i] === endPathParts[i]
  ) {
    commonPart = `${commonPart}/${startPathParts[i]}`;
    i++;
  }

  // Extract the last dissimilar segments (before the offsets)
  const dissimilarStart = startPath.slice(commonPart.length);
  const dissimilarEnd = endPath.slice(commonPart.length);

  // Determine if we need to include the last segment in the dissimilar part
  const startEntity = `/${dissimilarStart}:${startOffset}`;
  const endEntity = `/${dissimilarEnd}:${endOffset}`;

  // Format the result as epubcfi({common_part},{start_entity},{end_entity})
  return `epubcfi(${commonPart.slice(1)},${startEntity},${endEntity})`;
};

const searchCfiData = (cfiData, searchText) => {
  const normalizedSearchText = normalizeWhitespace(searchText);
  let found = false;

  const flattened = cfiData.flatMap((heading) =>
    heading.content.map((section) => ({
      node: normalizeWhitespace(section.node),
      cfi: section.cfi,
    }))
  );

  for (let i = 0; i < flattened.length; i++) {
    let combinedText = "";
    let charMap = [];
    let startCfi = "";
    let endCfi = "";
    let startOffset = -1;
    let endOffset = -1;

    for (let j = i; j < flattened.length; j++) {
      const currentNode = flattened[j];
      const currentText = currentNode.node;
      const currentTextLength = currentText.length;

      charMap.push({
        cfi: currentNode.cfi,
        start: combinedText.length,
        end: combinedText.length + currentTextLength,
      });

      combinedText += (j > i ? " " : "") + currentText;

      if (combinedText.includes(normalizedSearchText)) {
        console.log("Current Node:", currentNode.node);
        console.log("Lenght of the combinedText:", combinedText.length);
        const startIdx = combinedText.indexOf(normalizedSearchText) - 1;
        const endIdx = startIdx + normalizedSearchText.length;

        for (const map of charMap) {
          if (startIdx >= map.start && startIdx < map.end) {
            startCfi = map.cfi;
            startOffset = startIdx - map.start;
          }
          if (endIdx > map.start && endIdx <= map.end) {
            endCfi = map.cfi;
            endOffset = endIdx - map.start;
          }
        }

        // Format and output the result with EPUB CFI format
        console.log(
          formatEpubCfi(startCfi, endCfi, startOffset, endOffset),
        );
        found = true;
        break;
      }

      if (combinedText.length > normalizedSearchText.length * 2) {
        break;
      }
    }

    if (found) break;
  }

  if (!found) {
    //console.log("Text not found in the EPUB.");
    process.exit(1);
  }
};

getCfis((error, cfiData) => {
  if (error) {
    process.exit(1);
  }
  searchCfiData(cfiData, searchText);
});
