import process from "node:process";

import { TABLE_BORDER_STYLE } from "./utils.js";

const ANSI_PATTERN = "\\u001B\\[[0-?]*[ -/]*[@-~]";
const ANSI_REGEX = new RegExp(ANSI_PATTERN, "g");
const COMBINING_MARK_REGEX = /\p{Mark}/u;
const BORDER_STYLES = {
  ascii: {
    bottomJoin: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    midJoin: "+",
    midLeft: "+",
    midRight: "+",
    topJoin: "+",
    topLeft: "+",
    topRight: "+",
    vertical: "|",
  },
  unicode: {
    bottomJoin: "┴",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    midJoin: "┼",
    midLeft: "├",
    midRight: "┤",
    topJoin: "┬",
    topLeft: "┌",
    topRight: "┐",
    vertical: "│",
  },
};

const stripAnsi = (input) => `${input ?? ""}`.replace(ANSI_REGEX, "");

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

const splitAnsiTokens = (line) => {
  const tokens = [];
  const ansiRegex = new RegExp(ANSI_PATTERN, "g");
  let cursor = 0;
  for (const match of line.matchAll(ansiRegex)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ isAnsi: false, value: line.slice(cursor, index) });
    }
    tokens.push({ isAnsi: true, value: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < line.length) {
    tokens.push({ isAnsi: false, value: line.slice(cursor) });
  }
  return tokens;
};

const wrapLineByChars = (line, width) => {
  if (line === "") {
    return [""];
  }
  if (width <= 0 || stringWidth(line) <= width) {
    return [line];
  }
  const wrapped = [];
  let chunk = "";
  let chunkWidth = 0;
  for (const token of splitAnsiTokens(line)) {
    if (token.isAnsi) {
      // Keep full ANSI sequences attached to the current chunk.
      chunk += token.value;
      continue;
    }
    for (const char of token.value) {
      const charWidth = stringWidth(char);
      if (chunkWidth + charWidth > width && chunk) {
        wrapped.push(chunk);
        chunk = "";
        chunkWidth = 0;
      }
      chunk += char;
      chunkWidth += charWidth;
    }
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
  const normalized = `${text ?? ""}`;
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

const resolveBorderStyle = (config = {}) => {
  const configBorderStyle = `${config.borderStyle || ""}`.toLowerCase();
  if (configBorderStyle === "ascii" || configBorderStyle === "unicode") {
    return configBorderStyle;
  }
  if (TABLE_BORDER_STYLE === "ascii" || TABLE_BORDER_STYLE === "unicode") {
    return TABLE_BORDER_STYLE;
  }
  const inCI = `${process.env.CI || ""}`.toLowerCase() === "true";
  return process.stdout?.isTTY && !inCI ? "unicode" : "ascii";
};

const resolveBorderChars = (config = {}) => {
  return BORDER_STYLES[resolveBorderStyle(config)] || BORDER_STYLES.ascii;
};

const drawBorder = (columns, borderChars, position = "mid") => {
  const left =
    position === "top"
      ? borderChars.topLeft
      : position === "bottom"
        ? borderChars.bottomLeft
        : borderChars.midLeft;
  const join =
    position === "top"
      ? borderChars.topJoin
      : position === "bottom"
        ? borderChars.bottomJoin
        : borderChars.midJoin;
  const right =
    position === "top"
      ? borderChars.topRight
      : position === "bottom"
        ? borderChars.bottomRight
        : borderChars.midRight;
  return `${left}${columns.map((c) => borderChars.horizontal.repeat(c.width + 2)).join(join)}${right}`;
};

const renderRow = (row, columns, borderChars) => {
  const wrappedColumns = columns.map((column, index) => {
    return wrapCellText(row?.[index] ?? "", column.width, column.wrapWord);
  });
  let maxHeight = 1;
  for (const lines of wrappedColumns) {
    maxHeight = Math.max(maxHeight, lines.length);
  }
  const rendered = [];
  for (let lineIndex = 0; lineIndex < maxHeight; lineIndex++) {
    const columnSeparator = ` ${borderChars.vertical} `;
    const line = columns
      .map((column, columnIndex) => {
        const raw = wrappedColumns[columnIndex][lineIndex] ?? "";
        return alignText(raw, column.width, column.alignment);
      })
      .join(columnSeparator);
    rendered.push(`${borderChars.vertical} ${line} ${borderChars.vertical}`);
  }
  return rendered;
};

const renderHeader = (header, columns, borderChars) => {
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
        `${borderChars.vertical} ${alignText(wrappedLine, totalWidth, contentAlignment)} ${borderChars.vertical}`,
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
  const borderChars = resolveBorderChars(config);
  const topBorder = drawBorder(columns, borderChars, "top");
  const middleBorder = drawBorder(columns, borderChars, "mid");
  const bottomBorder = drawBorder(columns, borderChars, "bottom");
  const output = [topBorder];
  const headerLines = renderHeader(config.header, columns, borderChars);
  if (headerLines.length) {
    output.push(...headerLines);
    output.push(middleBorder);
  }
  for (let i = 0; i < rows.length; i++) {
    output.push(...renderRow(rows[i], columns, borderChars));
    output.push(i < rows.length - 1 ? middleBorder : bottomBorder);
  }
  return output.join("\n");
};

export function table(rows, config = {}) {
  return formatTable(rows, config);
}

export function createStream(config = {}) {
  let columns;
  let middleBorder;
  let bottomBorder;
  let hasRows = false;
  let closed = false;
  const borderChars = resolveBorderChars(config);

  return {
    write(row) {
      if (closed) {
        return;
      }
      if (!columns) {
        const seedRows = Array.isArray(row) ? [row] : [[row]];
        columns = buildColumns(seedRows, config);
        const topBorder = drawBorder(columns, borderChars, "top");
        middleBorder = drawBorder(columns, borderChars, "mid");
        bottomBorder = drawBorder(columns, borderChars, "bottom");
        process.stdout.write(`${topBorder}\n`);
      }
      if (hasRows) {
        process.stdout.write(`${middleBorder}\n`);
      }
      const safeRow = Array.isArray(row) ? row : [row];
      const rendered = renderRow(safeRow, columns, borderChars);
      process.stdout.write(`${rendered.join("\n")}\n`);
      hasRows = true;
    },
    end() {
      if (!columns || closed) {
        return;
      }
      process.stdout.write(`${bottomBorder}\n`);
      closed = true;
    },
  };
}
