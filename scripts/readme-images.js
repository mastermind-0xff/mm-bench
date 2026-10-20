// Renders the README's example output: runs the Quick start comparison for
// real, draws its colored report as an SVG in `assets/` (aligned whatever
// font the viewer has) and writes the same report as plain text into the
// README (for search engines, copy and paste, and readers without images).
// The numbers are from this machine and change on every run.
// Run with: npm run build && npm run images
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { charWidth } from '@mmutils/logger';
import { bench, compare, loggerReporter } from '@mmutils/bench';

const ASSETS = new URL('../assets/', import.meta.url);
const README = new URL('../README.md', import.meta.url);

// --- terminal theme -------------------------------------------------------

// VS Code's default dark terminal, as it draws: bold basic colors bright
// and every text color adjusted to a minimum contrast ratio
const THEME = {
  background: '#1e1e1e',
  border: '#444444',
  foreground: '#cccccc',
  // ANSI 0-15
  palette: [
    '#000000',
    '#cd3131',
    '#0dbc79',
    '#e5e510',
    '#2472c8',
    '#bc3fbc',
    '#11a8cd',
    '#e5e5e5',
    '#666666',
    '#f14c4c',
    '#23d18b',
    '#f5f543',
    '#3b8eea',
    '#d670d6',
    '#29b8db',
    '#e5e5e5',
  ],
  minimumContrastRatio: 4.5,
};
const FONT_SIZE = 14;
// whole pixels keep glyphs and frames sharp; between the advance of
// Consolas (7.7) and of SF Mono, Menlo and DejaVu Sans Mono (8.4)
const CELL_WIDTH = 8;
const LINE_HEIGHT = 19;
const BASELINE = 14; // from the top of a line
const PADDING = 16;
const FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace";

// --- ANSI parsing ---------------------------------------------------------

const RESET_STATE = {
  fg: undefined,
  bg: undefined,
  bold: false,
  invert: false,
};

const hex = (codes, index) => rgbToHex(codes.slice(index, index + 3));

const applySgr = (state, params) => {
  const codes = params === '' ? [0] : params.split(';').map(Number);
  let next = { ...state };
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    // 24-bit colors: 38;2;r;g;b and 48;2;r;g;b
    if ((code === 38 || code === 48) && codes[index + 1] === 2) {
      next[code === 38 ? 'fg' : 'bg'] = hex(codes, index + 2);
      index += 4;
    } else if (code === 0) next = { ...RESET_STATE };
    else if (code === 1) next.bold = true;
    else if (code === 22) next.bold = false;
    else if (code === 7) next.invert = true;
    else if (code === 27) next.invert = false;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
    else if (code === 39) next.fg = undefined;
    else if (code >= 40 && code <= 47) next.bg = code - 40;
    else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
    else if (code === 49) next.bg = undefined;
  }
  return next;
};

/** A color of the state: a palette index or a `#rrggbb` string. */
const color = (value, fallback) =>
  value === undefined ? fallback
  : typeof value === 'string' ? value
  : THEME.palette[value];

// --- contrast, as xterm.js (VS Code's terminal) does it ---------------------

const hexToRgb = (color) =>
  [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16));
const rgbToHex = (rgb) =>
  `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;

/** Relative luminance, as WCAG defines it. */
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ?
        channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrastRatio = (a, b) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * Moves a color 10% at a time towards black (`-1`) or white (`1`) until it
 * has the minimum contrast with the background luminance.
 */
const shiftColor = (rgb, background, direction) => {
  let next = rgb;
  while (
    contrastRatio(luminance(next), background) < THEME.minimumContrastRatio &&
    next.some((value) => (direction < 0 ? value > 0 : value < 255))
  )
    next = next.map((value) =>
      direction < 0 ?
        value - Math.ceil(value * 0.1)
      : Math.min(255, value + Math.ceil((255 - value) * 0.1))
    );
  return next;
};

/**
 * The text color with the minimum contrast: moved away from the background
 * first, the other way if that can't reach the ratio, whichever gets
 * closer (black on blue turns near white).
 */
const ensureContrast = (fg, bg) => {
  const rgb = hexToRgb(fg);
  const background = luminance(hexToRgb(bg));
  const own = luminance(rgb);
  if (contrastRatio(own, background) >= THEME.minimumContrastRatio) return fg;
  const direction = own < background ? -1 : 1;
  const away = shiftColor(rgb, background, direction);
  const awayRatio = contrastRatio(luminance(away), background);
  if (awayRatio >= THEME.minimumContrastRatio) return rgbToHex(away);
  const toward = shiftColor(rgb, background, -direction);
  return rgbToHex(
    awayRatio > contrastRatio(luminance(toward), background) ? away : toward
  );
};

/**
 * Splits a line into cells: one per character, with its column and colors.
 */
const parseLine = (line) => {
  const cells = [];
  let state = { ...RESET_STATE };
  let column = 0;
  for (let index = 0; index < line.length;) {
    if (line[index] === '\x1b') {
      const end = line.indexOf('m', index);
      state = applySgr(state, line.slice(index + 2, end));
      index = end + 1;
      continue;
    }
    const codePoint = line.codePointAt(index);
    const char = String.fromCodePoint(codePoint);
    index += char.length;
    const width = charWidth(codePoint);
    // zero-width characters (e.g. the emoji variation selector in ⚠️) belong
    // to the character before them
    const last = cells.at(-1);
    if (width === 0 && last) {
      last.char += char;
      continue;
    }
    // bold basic colors are drawn bright
    const fgIndex =
      state.bold && typeof state.fg === 'number' && state.fg < 8 ?
        state.fg + 8
      : state.fg;
    let fg = color(fgIndex, THEME.foreground);
    let bg = color(state.bg, undefined);
    if (state.invert) [fg, bg] = [bg ?? THEME.background, fg];
    fg = ensureContrast(fg, bg ?? THEME.background);
    cells.push({ char, column, width, fg, bg, bold: state.bold });
    column += width;
  }
  return { cells, width: column };
};

// --- SVG ------------------------------------------------------------------

const escapeXml = (text) =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]
  );

// lower eighth blocks ▁ … █, the upper blocks ▔ ▀ (eighths filled from the
// top) and the graph frame: drawn as rectangles, so bars join seamlessly
// whatever font the viewer has
const BLOCKS = ' ▁▂▃▄▅▆▇█';
const UPPER_BLOCKS = { '▔': 1, '▀': 4 };
const FRAME = '│';

const render = (lines) => {
  const parsed = lines.map(parseLine);
  const columns = Math.max(...parsed.map(({ width }) => width));
  const width = Math.ceil(columns * CELL_WIDTH + PADDING * 2);
  const height = Math.ceil(parsed.length * LINE_HEIGHT + PADDING * 2);
  const shapes = [];
  const texts = [];
  parsed.forEach(({ cells }, row) => {
    const top = PADDING + row * LINE_HEIGHT;
    const baseline = top + BASELINE;
    // backgrounds, merged per run of the same color
    for (let index = 0; index < cells.length;) {
      const { bg, column } = cells[index];
      let end = index;
      let span = 0;
      while (end < cells.length && cells[end].bg === bg)
        span += cells[end++].width;
      if (bg !== undefined)
        shapes.push(
          `<rect x="${x(column)}" y="${top}" width="${n(span * CELL_WIDTH)}" height="${LINE_HEIGHT}" fill="${bg}"/>`
        );
      index = end;
    }
    // block characters as rectangles, other characters as text runs with
    // one x per character, so wide characters and fallback fonts can't
    // shift the columns
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const { fg, bold } = run[0];
      // spaces are left out: every glyph has its own x, and viewers may
      // collapse whitespace
      const glyphs = run.filter(({ char }) => char !== ' ');
      const attributes = `y="${n(baseline)}" fill="${fg}"${bold ? ' font-weight="bold"' : ''}`;
      // one x per character: characters of more than one code point (⚠️)
      // get their own element, or they would take the next glyph's x
      const single = glyphs.filter(({ char }) => [...char].length === 1);
      if (single.length)
        texts.push(
          `<text x="${single.map(({ column }) => x(column)).join(' ')}" ${attributes}>${single.map(({ char }) => escapeXml(char)).join('')}</text>`
        );
      for (const { char, column } of glyphs)
        if ([...char].length > 1)
          texts.push(
            `<text x="${x(column)}" ${attributes}>${escapeXml(char)}</text>`
          );
      run = [];
    };
    for (const cell of cells) {
      const eighths = BLOCKS.indexOf(cell.char);
      const upper = UPPER_BLOCKS[cell.char] ?? 0;
      if (eighths > 0) {
        flush();
        const barHeight = (LINE_HEIGHT * eighths) / 8;
        shapes.push(
          `<rect x="${x(cell.column)}" y="${n(top + LINE_HEIGHT - barHeight)}" width="${n(CELL_WIDTH)}" height="${n(barHeight)}" fill="${cell.fg}"/>`
        );
      } else if (upper > 0) {
        flush();
        shapes.push(
          `<rect x="${x(cell.column)}" y="${top}" width="${n(CELL_WIDTH)}" height="${n((LINE_HEIGHT * upper) / 8)}" fill="${cell.fg}"/>`
        );
      } else if (cell.char === FRAME) {
        flush();
        shapes.push(
          `<rect x="${n(cell.column * CELL_WIDTH + PADDING + CELL_WIDTH / 2)}" y="${top}" width="1" height="${LINE_HEIGHT}" fill="${cell.fg}"/>`
        );
      } else {
        const last = run.at(-1);
        if (last && (last.fg !== cell.fg || last.bold !== cell.bold)) flush();
        run.push(cell);
      }
    }
    flush();
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="${THEME.background}" stroke="${THEME.border}"/>
<g shape-rendering="crispEdges">
${shapes.join('\n')}
</g>
<g font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}">
${texts.join('\n')}
</g>
</svg>
`;
};

const n = (value) => String(Math.round(value * 100) / 100);
const x = (column) => n(PADDING + column * CELL_WIDTH);

// --- README text ----------------------------------------------------------

/** The text the terminal shows: escape codes and trailing spaces removed. */
const plainText = (lines) =>
  lines
    .map((line) =>
      parseLine(line)
        .cells.map(({ char }) => char)
        .join('')
        .trimEnd()
    )
    .join('\n');

/**
 * Replaces the code block between `<!-- output:name -->` and
 * `<!-- /output -->` in the README with the text.
 */
const replaceOutput = (readme, name, text) => {
  const start = `<!-- output:${name} -->`;
  const from = readme.indexOf(start);
  const to = readme.indexOf('<!-- /output -->', from);
  if (from < 0 || to < 0) throw new Error(`README.md has no ${start} block`);
  return `${readme.slice(0, from + start.length)}\n\n\`\`\`text\n${text}\n\`\`\`\n\n${readme.slice(to)}`;
};

// --- the Quick start comparison ---------------------------------------------

// the workers run this file again, up to the call they measure: the data
// is prepared at the top level, the files are written after the last call
const words = Array.from({ length: 50 }, (_, index) => `word${index}`);

const lines = [];
await compare(
  bench('join', () => words.join(' ')),
  bench('concat', () => {
    let text = '';
    for (const word of words) text += word + ' ';
    return text;
  }),
  {
    // two columns of an 80-column terminal, three of the graphs, without
    // the progress lines
    output: loggerReporter({
      graphs: ['distribution', 'timeline', 'heapDelta'],
      columns: 2,
      width: 38,
      progress: false,
      colors: true,
      write: (text) => lines.push(...text.split('\n')),
    }),
  }
);

mkdirSync(ASSETS, { recursive: true });
writeFileSync(new URL('compare.svg', ASSETS), render(lines));
console.log('assets/compare.svg');
writeFileSync(
  README,
  replaceOutput(readFileSync(README, 'utf8'), 'compare', plainText(lines))
);
console.log('README.md');
