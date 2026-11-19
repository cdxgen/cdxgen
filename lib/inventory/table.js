import process from "node:process";

import { readEnvironmentVariable } from "../core/activity.js";
import { TABLE_BORDER_STYLE } from "../core/env.js";
import { diagnosticStream } from "../core/logger.js";
import {
  alignText,
  sanitizeTerminalText,
  stringWidth,
  wrapLineByChars,
  wrapLineByWords,
} from "../core/text.js";

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

const wrapCellText = (text, width, wrapWord) => {
  const normalized = sanitizeTerminalText(text);
  const lines = normalized.split("\n");
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
    const lines = sanitizeTerminalText(cell).split("\n");
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
  const inCI =
    `${readEnvironmentVariable("CI") || ""}`.toLowerCase() === "true";
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

// A cell that leaves a style open closes it before the border that follows.
const endStyle = (cell) => {
  const lastEscape = cell.lastIndexOf("\u001B[");
  if (lastEscape === -1) {
    return cell;
  }
  const sequence = cell.slice(lastEscape, cell.indexOf("m", lastEscape) + 1);
  return sequence === "\u001B[0m" || sequence === "\u001B[m"
    ? cell
    : `${cell}\u001B[0m`;
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
        return endStyle(alignText(raw, column.width, column.alignment));
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
  const headerLines = sanitizeTerminalText(header.content).split("\n");
  const rendered = [];
  for (const line of headerLines) {
    const wrapped = wrapLineByChars(line, totalWidth);
    for (const wrappedLine of wrapped) {
      rendered.push(
        `${borderChars.vertical} ${endStyle(alignText(wrappedLine, totalWidth, contentAlignment))} ${borderChars.vertical}`,
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

/**
 * Render rows as a bordered text table.
 *
 * @param {Array[]} rows Table rows
 * @param {Object} [config={}] Table configuration (header, columns, border style)
 * @returns {string} Rendered table, or an empty string when there are no rows
 */
export function table(rows, config = {}) {
  return formatTable(rows, config);
}

/**
 * Create a streaming table writer that renders rows incrementally.
 *
 * Rows go to the diagnostic stream: a rendered table is human-readable output,
 * and writing it to stdout corrupted the BOM document under `-o -`.
 *
 * @param {Object} [config={}] Table configuration (header, columns, border style)
 * @returns {{write(row: *): void, end(): void}} Writer whose `end()` emits the bottom border
 */
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
        diagnosticStream.write(`${topBorder}\n`);
      }
      if (hasRows) {
        diagnosticStream.write(`${middleBorder}\n`);
      }
      const safeRow = Array.isArray(row) ? row : [row];
      const rendered = renderRow(safeRow, columns, borderChars);
      diagnosticStream.write(`${rendered.join("\n")}\n`);
      hasRows = true;
    },
    end() {
      if (!columns || closed) {
        return;
      }
      diagnosticStream.write(`${bottomBorder}\n`);
      closed = true;
    },
  };
}
