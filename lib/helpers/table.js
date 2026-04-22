import process from "node:process";

const ANSI_PATTERN = "\\u001B\\[[0-?]*[ -/]*[@-~]";
const ANSI_REGEX = new RegExp(ANSI_PATTERN, "g");
const COMBINING_MARK_REGEX = /\p{Mark}/u;

const stripAnsi = (input) => `${input || ""}`.replace(ANSI_REGEX, "");

const isFullWidthCodePoint = (codePoint) => {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff))
  );
};

const stringWidth = (input) => {
  const clean = stripAnsi(input);
  let width = 0;
  for (const char of clean) {
    if (char === "\n" || char === "\r") {
      continue;
    }
    if (COMBINING_MARK_REGEX.test(char)) {
      continue;
    }
    const codePoint = char.codePointAt(0);
    width += isFullWidthCodePoint(codePoint) ? 2 : 1;
  }
  return width;
};

const alignText = (text, width, alignment = "left") => {
  const visibleWidth = stringWidth(text);
  if (visibleWidth >= width) {
    return text;
  }
  const totalPad = width - visibleWidth;
  if (alignment === "right") {
    return `${" ".repeat(totalPad)}${text}`;
  }
  if (alignment === "center") {
    const left = Math.floor(totalPad / 2);
    const right = totalPad - left;
    return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
  }
  return `${text}${" ".repeat(totalPad)}`;
};

const wrapLineByChars = (line, width) => {
  if (!line) {
    return [""];
  }
  if (width <= 0 || stringWidth(line) <= width) {
    return [line];
  }
  const wrapped = [];
  let chunk = "";
  let chunkWidth = 0;
  for (const char of line) {
    const charWidth = stringWidth(char);
    if (chunkWidth + charWidth > width && chunk) {
      wrapped.push(chunk);
      chunk = "";
      chunkWidth = 0;
    }
    chunk += char;
    chunkWidth += charWidth;
  }
  if (chunk) {
    wrapped.push(chunk);
  }
  return wrapped.length ? wrapped : [""];
};

const wrapLineByWords = (line, width) => {
  if (!line) {
    return [""];
  }
  if (width <= 0 || stringWidth(line) <= width) {
    return [line];
  }
  const words = line.split(/\s+/).filter(Boolean);
  if (!words.length) {
    return wrapLineByChars(line, width);
  }
  const wrapped = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (stringWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current) {
      wrapped.push(current);
    }
    if (stringWidth(word) > width) {
      wrapped.push(...wrapLineByChars(word, width));
      current = "";
    } else {
      current = word;
    }
  }
  if (current) {
    wrapped.push(current);
  }
  return wrapped.length ? wrapped : [""];
};

const wrapCellText = (text, width, wrapWord) => {
  const normalized = `${text || ""}`;
  const lines = normalized.split(/\r?\n/);
  const wrapped = [];
  for (const line of lines) {
    if (wrapWord) {
      wrapped.push(...wrapLineByChars(line, width));
    } else {
      wrapped.push(...wrapLineByWords(line, width));
    }
  }
  return wrapped.length ? wrapped : [""];
};

const getColumnCount = (rows, config = {}) => {
  let maxCols = 0;
  for (const row of rows) {
    if (Array.isArray(row)) {
      maxCols = Math.max(maxCols, row.length);
    }
  }
  if (Array.isArray(config.columns)) {
    maxCols = Math.max(maxCols, config.columns.length);
  }
  if (config.columnCount) {
    maxCols = Math.max(maxCols, config.columnCount);
  }
  return maxCols;
};

const inferColumnWidth = (rows, columnIndex) => {
  let maxWidth = 3;
  for (const row of rows) {
    const cell = row?.[columnIndex];
    if (cell === undefined || cell === null) {
      continue;
    }
    const lines = `${cell}`.split(/\r?\n/);
    for (const line of lines) {
      maxWidth = Math.max(maxWidth, stringWidth(line));
    }
  }
  return Math.min(maxWidth, 120);
};

const buildColumns = (rows, config = {}) => {
  const columnDefault = config.columnDefault || {};
  const columns = Array.isArray(config.columns) ? config.columns : [];
  const count = getColumnCount(rows, config);
  const built = [];
  for (let i = 0; i < count; i++) {
    const explicit = columns[i] || {};
    const inferredWidth = inferColumnWidth(rows, i);
    built.push({
      alignment: explicit.alignment || columnDefault.alignment || "left",
      width: Math.max(
        1,
        explicit.width || columnDefault.width || inferredWidth,
      ),
      wrapWord: explicit.wrapWord ?? columnDefault.wrapWord ?? false,
    });
  }
  return built;
};

const drawBorder = (columns) => {
  return `+${columns.map((c) => "-".repeat(c.width + 2)).join("+")}+`;
};

const renderRow = (row, columns) => {
  const wrappedColumns = columns.map((column, index) => {
    return wrapCellText(row?.[index] || "", column.width, column.wrapWord);
  });
  let maxHeight = 1;
  for (const lines of wrappedColumns) {
    maxHeight = Math.max(maxHeight, lines.length);
  }
  const rendered = [];
  for (let lineIndex = 0; lineIndex < maxHeight; lineIndex++) {
    const line = columns
      .map((column, columnIndex) => {
        const raw = wrappedColumns[columnIndex][lineIndex] || "";
        return alignText(raw, column.width, column.alignment);
      })
      .join(" | ");
    rendered.push(`| ${line} |`);
  }
  return rendered;
};

const renderHeader = (header, columns) => {
  if (!header?.content) {
    return [];
  }
  const contentAlignment = header.alignment || "left";
  const totalWidth =
    columns.reduce((sum, c) => sum + c.width, 0) + (columns.length - 1) * 3;
  const headerLines = `${header.content}`.split(/\r?\n/);
  const rendered = [];
  for (const line of headerLines) {
    const wrapped = wrapLineByChars(line, totalWidth);
    for (const wrappedLine of wrapped) {
      rendered.push(
        `| ${alignText(wrappedLine, totalWidth, contentAlignment)} |`,
      );
    }
  }
  return rendered;
};

const formatTable = (rows, config = {}) => {
  if (!rows?.length) {
    return "";
  }
  const columns = buildColumns(rows, config);
  const border = drawBorder(columns);
  const output = [border];
  const headerLines = renderHeader(config.header, columns);
  if (headerLines.length) {
    output.push(...headerLines);
    output.push(border);
  }
  for (const row of rows) {
    output.push(...renderRow(row, columns));
    output.push(border);
  }
  return output.join("\n");
};

export function table(rows, config = {}) {
  return formatTable(rows, config);
}

export function createStream(config = {}) {
  let columns;
  let border;

  return {
    write(row) {
      if (!columns) {
        const seedRows = Array.isArray(row) ? [row] : [[row]];
        columns = buildColumns(seedRows, config);
        border = drawBorder(columns);
        process.stdout.write(`${border}\n`);
      }
      const safeRow = Array.isArray(row) ? row : [row];
      const rendered = renderRow(safeRow, columns);
      process.stdout.write(`${rendered.join("\n")}\n${border}\n`);
    },
  };
}
