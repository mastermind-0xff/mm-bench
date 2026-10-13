import type { BakedStyles, GraphAxis, LoggerPlugin } from 'mm-logger';
import { distribution } from './distribution.js';
import {
  escapeControls,
  formatCount,
  formatRelative,
  formatTime,
  niceCeil,
  timeUnit,
} from './format.js';
import { caseSeries, cpuWindowOf, stretch, type CaseSeries } from './series.js';
import type {
  CaseReport,
  GraphName,
  LoggerReporterFunction,
  LoggerReporterOptions,
  Plan,
  Report,
  Reporter,
  ResolvedMeasureOptions,
  SampleProgress,
} from './types.js';

/** Graphs of `loggerReporter`, in their order in its reports. */
export const GRAPH_NAMES: readonly GraphName[] = Object.freeze([
  'distribution',
  'timeline',
  'thread',
  'cores',
  'heapDelta',
  'heap',
  'machine',
]);

/** Graphs `loggerReporter` draws by default: all but `'machine'`. */
export const DEFAULT_GRAPHS: readonly GraphName[] = Object.freeze(
  GRAPH_NAMES.filter((graph) => graph !== 'machine')
);

const MIN_WIDTH = 20;
/** Narrowest column when the reporter picks the number of columns. */
const PREFERRED_WIDTH = 40;
const FRAME = ' | ';
const TEXT_KIND = 'mm-bench';
/** Runs shorter than this many timer steps get a batchSize hint. */
const COARSE_STEPS = 5;
/** Timer steps per run the batchSize hint aims at. */
const TARGET_STEPS = 20;
/** Cases with fewer runs get a hint that their distribution is rough. */
const FEW_RUNS = 1000;
const MB = 1024 ** 2;
/** Strip symbols of the machine's cores, from idle to fully busy. */
const STRIP_SYMBOLS = ' ▁▂▃▄▅▆▇█';
/** Width of a core's average busy share after its strip: ` 100%`. */
const SHARE_WIDTH = 5;
/**
 * Share of the machine's CPU, in percent, other processes may use while a
 * case is measured before the case gets a busy machine warning.
 */
const BUSY_MACHINE = 10;

/** Styles added to the logger's, by name. */
const STYLES = {
  benchGood: '\x1b[1;32m',
  benchBad: '\x1b[1;31m',
  benchWarn: '\x1b[33m',
} as const;

type StyleName =
  keyof typeof STYLES | 'textDim' | 'textNormal' | 'textHighlight';

/** A piece of text and its style. */
type Segment = readonly [text: string, style: StyleName];

/** A line: segments on the left, optionally others on the right. */
interface TextLine {
  readonly left: readonly Segment[];
  readonly right?: readonly Segment[];
}

/** Data of the reporter's text logs. */
interface TextBlock {
  readonly width: number;
  readonly lines: readonly TextLine[];
}

interface TextMethods {
  benchText(block: TextBlock): void;
}

type MmLogger = typeof import('mm-logger');

const fail = (name: string, expected: string, value: unknown): never => {
  throw new RangeError(
    `mm-bench: loggerReporter ${name} must be ${expected}, got ${String(value)}.`
  );
};

const checkInteger = (
  name: string,
  value: unknown,
  min: number,
  max: number
): void => {
  if (value === undefined) return;
  if (!(
    Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  ))
    fail(name, `an integer from ${String(min)} to ${String(max)}`, value);
};

const checkOptions = (options: LoggerReporterOptions): void => {
  const {
    width,
    columns,
    graphs,
    buckets,
    trim,
    rows,
    progress,
    colors,
    write,
  } = options;
  checkInteger('width', width, MIN_WIDTH, 10_000);
  checkInteger('columns', columns, 1, 100);
  checkInteger('rows', rows, 2, 50);
  if (buckets !== undefined && buckets !== 'cols')
    checkInteger('buckets', buckets, 1, 10_000);
  if (trim !== undefined && !(trim >= 0 && trim < 0.5))
    fail('trim', 'at least 0 and below 0.5', trim);
  if (
    graphs !== undefined &&
    !(
      Array.isArray(graphs) &&
      (graphs as unknown[]).every((graph) =>
        (GRAPH_NAMES as readonly unknown[]).includes(graph)
      )
    )
  )
    fail('graphs', `a list of ${GRAPH_NAMES.join(', ')}`, graphs);
  if (progress !== undefined && typeof progress !== 'boolean')
    fail('progress', 'a boolean', progress);
  if (colors !== undefined && typeof colors !== 'boolean')
    fail('colors', 'a boolean', colors);
  if (write !== undefined && typeof write !== 'function')
    fail('write', 'a function', typeof write);
};

/** Renders text blocks; a plugin, so the blocks can be laid out in columns. */
const textPlugin = (
  { paint, textWidth }: MmLogger,
  write: (text: string) => void
): LoggerPlugin<TextMethods> => {
  const paintSegments = (segments: readonly Segment[], styles: BakedStyles) =>
    segments
      .map(([text, style]) =>
        paint(styles[style] ?? '', text, styles.reset ?? '')
      )
      .join('');
  const plain = (segments: readonly Segment[]): string =>
    segments.map(([text]) => text).join('');
  const render = ({ width, lines }: TextBlock, styles: BakedStyles): string =>
    lines
      .map(({ left, right = [] }) => {
        const gap = width - textWidth(plain(left)) - textWidth(plain(right));
        if (right.length === 0) return paintSegments(left, styles);
        return gap >= 1 ?
            `${paintSegments(left, styles)}${' '.repeat(gap)}${paintSegments(right, styles)}`
          : `${paintSegments(left, styles)}\n${paintSegments(right, styles)}`;
      })
      .join('\n');
  return {
    name: 'mm-bench-text',
    templateMaps: {
      [TEXT_KIND]: {
        id: () => '',
        type: () => '',
        kind: () => '',
        data: (value, { styles }) => render(value as TextBlock, styles),
      },
    },
    outputs: {
      [TEXT_KIND]: (entry) => {
        let text = '';
        for (const key in entry) text += String(entry[key]);
        write(text);
      },
    },
    methods: (logger) => ({
      benchText: (block) => {
        logger.log('info', block, TEXT_KIND);
      },
    }),
  };
};

/** Short description of a case's budget. */
const describeBudget = (options: ResolvedMeasureOptions): string => {
  if ('runs' in options) return `${formatCount(options.runs)} runs`;
  if (typeof options.time === 'number') return formatTime(options.time * 1e6);
  const { min, max, runs } = options.time;
  return `auto: ${formatTime(min * 1e6)}–${formatTime(max * 1e6)}, aiming at ${formatCount(runs)} runs`;
};

const describeWarmup = ({ warmup }: ResolvedMeasureOptions): string =>
  'time' in warmup ?
    `${formatTime(warmup.time * 1e6)} warm-up`
  : `${formatCount(warmup.runs)} warm-up runs`;

/** Mean time per call of a sample, overhead subtracted when it's on. */
const sampleMean = (
  { result }: SampleProgress,
  { batchSize, subtractOverhead }: ResolvedMeasureOptions
): number =>
  Math.max(
    0,
    result.innerTime / result.runs / batchSize -
      (subtractOverhead ? result.overhead : 0)
  );

/** Statistic labels and values, two pairs a line when they fit. */
const statLines = (
  pairs: readonly (readonly [string, string])[],
  width: number
): TextLine[] => {
  const labelWidth = Math.max(...pairs.map(([label]) => label.length)) + 1;
  const half = Math.floor(width / 2);
  const twoPerLine = width >= 2 * (labelWidth + 12);
  const segments = ([label, value]: readonly [string, string]): Segment[] => [
    [label.padEnd(labelWidth), 'textDim'],
    [value, 'textHighlight'],
  ];
  const lines: TextLine[] = [];
  for (let index = 0; index < pairs.length; index += twoPerLine ? 2 : 1) {
    const first = pairs[index];
    const second = twoPerLine ? pairs[index + 1] : undefined;
    if (first === undefined) break;
    const left = segments(first);
    if (second === undefined) lines.push({ left });
    else {
      const used = labelWidth + first[1].length;
      lines.push({
        left: [
          ...left,
          [' '.repeat(Math.max(1, half - used)), 'textDim'],
          ...segments(second),
        ],
      });
    }
  }
  return lines;
};

/** How busy the machine was while a case was measured. */
interface MachineLoad {
  /** All processes, in percent of all the machine's cores. */
  readonly busy: number;
  /** Other processes than this one, in percent of all the machine's cores. */
  readonly others: number;
}

/** `undefined` when the OS doesn't report the machine's cores. */
const machineLoad = ({
  machine,
  cores,
}: CaseSeries): MachineLoad | undefined => {
  if (machine.length === 0) return undefined;
  const busy =
    machine.reduce((sum, values) => sum + average(values), 0) / machine.length;
  const own = (average(cores) / machine.length) * 100;
  return { busy, others: Math.max(0, busy - own) };
};

/** Hints about how much to trust a case's numbers. */
const hints = (
  caseReport: CaseReport,
  timerResolution: number,
  load: MachineLoad | undefined
): TextLine[] => {
  const { stats, overhead, options } = caseReport;
  const lines: TextLine[] = [];
  if (load !== undefined && load.others >= BUSY_MACHINE)
    lines.push({
      left: [
        [
          `! busy machine: other processes used ${String(Math.round(load.others))}% CPU`,
          'benchWarn',
        ],
      ],
    });
  const rawPerRun =
    (stats.mean + (options.subtractOverhead ? overhead : 0)) *
    options.batchSize;
  if (rawPerRun < COARSE_STEPS * timerResolution) {
    const batch = niceCeil(
      (TARGET_STEPS * timerResolution * options.batchSize) /
        Math.max(rawPerRun, 1)
    );
    lines.push({
      left: [
        [
          `! runs take ${formatTime(rawPerRun)}, the timer steps ${formatTime(timerResolution)}: try batchSize: ${String(batch)}`,
          'benchWarn',
        ],
      ],
    });
  }
  if (stats.runs < FEW_RUNS)
    lines.push({
      left: [
        [
          `! ${formatCount(stats.runs)} runs: a rough distribution${'runs' in options ? '' : '; raise time for more'}`,
          'benchWarn',
        ],
      ],
    });
  return lines;
};

const average = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

/** A share of runs in percent: `0%`, `0.04%`, `1.2%`, `12%`. */
const formatShare = (share: number): string => {
  const percent = share * 100;
  return (
    percent === 0 ? '0%'
    : percent < 1 ? `${percent.toFixed(2)}%`
    : percent < 10 ? `${percent.toFixed(1)}%`
    : `${percent.toFixed(0)}%`
  );
};

/**
 * Title and stats of a case.
 *
 * @param outside Share of the case's runs outside the distribution graph.
 * @param load How busy the machine was, for a warning.
 */
const caseText = (
  caseReport: CaseReport,
  report: Report,
  width: number,
  outside: number,
  load: MachineLoad | undefined
): TextBlock => {
  const { name, async, stats, relative, overhead, options } = caseReport;
  const title: Segment[] = [[escapeControls(name), 'textHighlight']];
  if (async) title.push([' async', 'textDim']);
  const right: Segment[] =
    report.cases.length < 2 ? []
    : relative <= 1 ? [['fastest', 'benchGood']]
    : [[formatRelative(relative), 'benchBad']];
  const pairs: (readonly [string, string])[] = [
    ['mean', formatTime(stats.mean)],
    ['median', formatTime(stats.median)],
    ['p99', formatTime(stats.p99)],
    ['p99.9', formatTime(stats.p999)],
    ['ops/s', formatCount(stats.opsPerSecond)],
    ['runs', formatCount(stats.runs)],
    ['stddev', formatTime(stats.stdDev)],
    ['off graph', formatShare(outside)],
    [
      'overhead',
      `${formatTime(overhead)}${options.subtractOverhead ? ' (subtracted)' : ''}`,
    ],
  ];
  return {
    width,
    lines: [
      // a blank line apart from the case above, when cases are stacked
      { left: [] },
      { left: title, right },
      ...statLines(pairs, width),
      ...hints(caseReport, report.environment.timerResolution, load),
    ],
  };
};

/** Time axis labels, formatted as the graphs format theirs. */
interface AxisLabels {
  readonly start: string;
  readonly end: string;
}

/** A core's busy shares in percent as a one-line strip of bars. */
const stripOf = (percents: readonly number[]): string =>
  percents
    .map((percent) => {
      const level = Math.round(Math.min(100, Math.max(0, percent)) / 12.5);
      return STRIP_SYMBOLS[Number.isNaN(level) ? 0 : level] ?? ' ';
    })
    .join('');

/**
 * The machine's cores while a case was measured, all processes: a strip
 * per core, the time axis, and how busy the machine was, all processes
 * and other processes than this one.
 *
 * @param machine Busy share of each core per column, in percent.
 */
const machineText = (
  machine: readonly (readonly number[])[],
  load: MachineLoad | undefined,
  width: number,
  axis: AxisLabels
): TextBlock => {
  const title: Segment = ['Machine cores, all processes', 'textHighlight'];
  if (load === undefined)
    return {
      width,
      lines: [
        { left: [] },
        { left: [title] },
        { left: [['not reported by the OS', 'textDim']] },
      ],
    };
  const labelWidth = String(machine.length - 1).length + 1;
  const bars = Math.max(1, width - labelWidth - 2 - SHARE_WIDTH);
  const shares = machine.map((values) => average(values));
  const percent = (value: number): string => `${String(Math.round(value))}%`;
  return {
    width,
    lines: [
      // a blank line apart from the graph above, as between graphs
      { left: [] },
      { left: [title] },
      ...machine.map((values, core): TextLine => ({
        left: [
          [
            String(core)
              .padStart(labelWidth - 1)
              .padEnd(labelWidth),
            'textDim',
          ],
          [`│${stripOf(stretch(values, bars))}│`, 'textHighlight'],
          [percent(shares[core] ?? 0).padStart(SHARE_WIDTH), 'textDim'],
        ],
      })),
      {
        left: [[`${' '.repeat(labelWidth)}${axis.start}`, 'textDim']],
        right: [[`${axis.end}${' '.repeat(SHARE_WIDTH)}`, 'textDim']],
      },
      {
        left: [
          ['busy: ', 'textNormal'],
          [percent(load.busy), 'textHighlight'],
        ],
        right: [
          ['other processes: ', 'textNormal'],
          [percent(load.others), 'textHighlight'],
        ],
      },
    ],
  };
};

/** Terminal columns; 80 when stdout is not a terminal. */
const terminalWidth = (): number =>
  (process.stdout as { columns?: number }).columns ?? 80;

interface Layout {
  readonly columns: number;
  readonly width: number;
}

const layout = (cases: number, options: LoggerReporterOptions): Layout => {
  const terminal = terminalWidth();
  const fitting = (width: number): number =>
    Math.max(1, Math.floor((terminal + FRAME.length) / (width + FRAME.length)));
  const columns = Math.min(
    cases,
    options.columns ?? fitting(options.width ?? PREFERRED_WIDTH)
  );
  const width =
    options.width ??
    Math.max(
      MIN_WIDTH,
      Math.floor((terminal - FRAME.length * (columns - 1)) / columns)
    );
  return { columns, width };
};

/**
 * Prints progress and reports with mm-logger: a line per sample, then one
 * column per case with its stats and graphs, side by side. Axes and
 * ceilings are shared by the cases, so the graphs compare at a glance.
 *
 * @throws RangeError for invalid options.
 */
export const loggerReporter: LoggerReporterFunction = (options = {}) => {
  checkOptions(options);
  const write =
    options.write ??
    ((text: string) => {
      console.log(text);
    });
  const colors = options.colors ?? !process.env.NO_COLOR;
  const graphs = options.graphs ?? DEFAULT_GRAPHS;
  const rows = options.rows ?? 9;
  let loaded: MmLogger | undefined;
  let plan: Plan | undefined;

  const createLogger = (mm: MmLogger, { columns, width }: Layout) => {
    const logger = new mm.Logger({
      timestamp: false,
      useStyles: colors,
      plugins: [
        textPlugin(mm, write),
        mm.graphPlugin({ width, write }),
        mm.columnsPlugin({
          columns,
          width,
          frame: FRAME,
          kinds: [TEXT_KIND, 'graph'],
          wrap: { [TEXT_KIND]: 'word' },
          indent: 2,
          write,
        }),
      ],
    });
    // graphs without the log header, the reporter's own lines name them
    logger.addTemplateMap('graph', { type: () => '' });
    logger.addStyles({ '*': STYLES });
    return logger;
  };

  let lines: ReturnType<typeof createLogger> | undefined;

  const reporter: Reporter = {
    async start(next) {
      loaded ??= await import('mm-logger');
      plan = next;
      const { environment: env, cases } = next;
      const first = cases[0]?.options;
      const terminal = Math.max(MIN_WIDTH, terminalWidth());
      lines = createLogger(loaded, { columns: 1, width: terminal });
      const header: TextLine[] = [
        {
          left: [
            ['mm-bench', 'textHighlight'],
            [
              `  node ${env.node} · ${env.platform} ${env.arch} · ${env.cpu} (${String(env.cores)} cores) · timer step ${formatTime(env.timerResolution)}`,
              'textDim',
            ],
          ],
        },
      ];
      if (first !== undefined)
        header.push({
          left: [
            [
              `${String(cases.length)} case${cases.length === 1 ? '' : 's'} · ${String(first.samples)} samples · ${describeBudget(first)} · ${describeWarmup(first)}${first.batchSize > 1 ? ` · batches of ${String(first.batchSize)}` : ''}`,
              'textDim',
            ],
          ],
        });
      lines.benchText({ width: terminal, lines: header });
    },

    sample(progress) {
      if (options.progress === false || lines === undefined) return;
      const caseOptions = plan?.cases.find(
        ({ name }) => name === progress.case
      )?.options;
      const { result } = progress;
      lines.benchText({
        width: 80,
        lines: [
          {
            left: [
              [
                `  sample ${String(progress.sample)}/${String(progress.samples)}  `,
                'textDim',
              ],
              [escapeControls(progress.case), 'textNormal'],
              [
                `  ${formatCount(result.runs)} runs in ${formatTime(result.outerTime)}${caseOptions === undefined ? '' : ` · mean ${formatTime(sampleMean(progress, caseOptions))}`}`,
                'textDim',
              ],
            ],
          },
        ],
      });
    },

    async end(report) {
      if (report.cases.length === 0) return;
      const mm = (loaded ??= await import('mm-logger'));
      const { columns, width } = layout(report.cases.length, options);
      const logger = createLogger(mm, { columns, width });
      const cols = width - 2;
      const small = Math.max(2, Math.round(rows / 3));
      // numbers in ns: the logger formats them, two units at most, e.g.
      // `0s … 2s 496ms`
      const axisOf = (duration: number): GraphAxis => ({
        start: 0,
        end: duration,
        unit: 'ns',
        capTo: 1,
      });
      const labelsOf = (axis: GraphAxis): AxisLabels => ({
        start: mm.formatAxisLabel(axis.start, axis, axis.end),
        end: mm.formatAxisLabel(axis.end, axis, axis.start),
      });
      // graphs over the sample show their average, min and max
      const common = {
        width,
        showAverage: true,
        showMin: true,
        showMax: true,
      };
      const machineCores = report.environment.cores;

      const dist = distribution(report, {
        buckets:
          options.buckets === undefined || options.buckets === 'cols' ?
            cols
          : options.buckets,
        ...(options.trim === undefined ? {} : { trim: options.trim }),
      });
      const percentMax = Math.max(
        ...dist.cases.flatMap(({ percents }) => percents)
      );
      const cpuWindow = cpuWindowOf(report.environment.platform);
      const series = report.cases.map(
        ({ samples, options: caseOptions, overhead }) =>
          caseSeries(samples, cols, {
            batchSize: caseOptions.batchSize,
            shift: caseOptions.subtractOverhead ? overhead : 0,
            cpuWindow,
          })
      );
      // every bucket a whole number of columns wide, see `distribution`;
      // more buckets than columns are scaled down by the graph
      const bucketCount = Math.max(1, dist.cases[0]?.percents.length ?? cols);
      const distributionWidth =
        bucketCount <= cols ?
          Math.floor(cols / bucketCount) * bucketCount + 2
        : width;
      const timelineMax = Math.max(
        ...series.flatMap(({ timeline }) => timeline)
      );
      const unit = timeUnit(timelineMax);
      // percent of all the machine's cores
      const allCores = series.map(({ cores }) =>
        cores.map((value) => (value / machineCores) * 100)
      );
      // the highest of the compared cases, so their graphs compare
      const allCoresMax = Math.max(0.1, ...allCores.flat());
      const loads = series.map(machineLoad);
      const heapMax =
        Math.max(...series.flatMap(({ heapUsed }) => heapUsed)) / MB;
      const heapDeltaMax =
        Math.max(...series.flatMap(({ heapDelta }) => heapDelta)) / MB;

      report.cases.forEach((caseReport, index) => {
        const caseSeriesOf = series[index];
        const caseDistribution = dist.cases[index];
        const percents = caseDistribution?.percents ?? [];
        const outside =
          caseDistribution === undefined ? 0 : (
            (caseDistribution.below + caseDistribution.above) /
            caseReport.stats.runs
          );
        logger.column(index % columns);
        logger.benchText(
          caseText(caseReport, report, width, outside, loads[index])
        );
        if (caseSeriesOf === undefined) return;
        const axis = axisOf(caseSeriesOf.duration);
        for (const graph of graphs)
          switch (graph) {
            case 'distribution':
              // the stats above describe the runs; the average, min and
              // max of the buckets' shares wouldn't
              logger.infoGraph(percents, {
                width: distributionWidth,
                showAverage: false,
                showMin: false,
                showMax: false,
                title: 'Run time, % of runs',
                unit: '%',
                precision: 1,
                rows,
                max: percentMax,
                axis: {
                  start: dist.start,
                  end: dist.end,
                  unit: 'ns',
                  capTo: 1,
                },
              });
              break;
            case 'timeline':
              logger.infoGraph(
                caseSeriesOf.timeline.map((value) => value / unit.size),
                {
                  ...common,
                  title: 'Mean run time over the sample',
                  unit: unit.name,
                  precision: 2,
                  rows: small,
                  max: timelineMax / unit.size,
                  axis,
                }
              );
              break;
            case 'thread':
              if (caseSeriesOf.thread.length === 0)
                logger.benchText({
                  width,
                  lines: [
                    {
                      left: [
                        [
                          "Function's thread: needs a Node version with process.threadCpuUsage",
                          'textDim',
                        ],
                      ],
                    },
                  ],
                });
              else
                logger.infoGraph(caseSeriesOf.thread, {
                  ...common,
                  title: "Function's thread, % of a core",
                  unit: '%',
                  precision: 0,
                  rows: small,
                  max: 100,
                  axis,
                });
              break;
            case 'cores':
              logger.infoGraph(allCores[index] ?? [], {
                ...common,
                title: `All cores usage, % of ${String(machineCores)} cores`,
                unit: '%',
                precision: 1,
                rows: small,
                max: allCoresMax,
                axis,
              });
              break;
            case 'heapDelta':
              logger.infoGraph(
                caseSeriesOf.heapDelta.map((bytes) => bytes / MB),
                {
                  ...common,
                  title: `Delta heap, thread cost ${(caseSeriesOf.heapBase / MB).toFixed(1)} MB`,
                  unit: 'MB',
                  precision: 2,
                  rows: small,
                  max: heapDeltaMax,
                  axis,
                }
              );
              break;
            case 'heap':
              logger.infoGraph(
                caseSeriesOf.heapUsed.map((bytes) => bytes / MB),
                {
                  ...common,
                  title: 'Total heap used',
                  unit: 'MB',
                  precision: 1,
                  rows: small,
                  max: heapMax,
                  axis,
                }
              );
              break;
            case 'machine':
              logger.benchText(
                machineText(
                  caseSeriesOf.machine,
                  loads[index],
                  width,
                  labelsOf(axis)
                )
              );
              break;
          }
      });
      logger.endColumns();
    },
  };
  return reporter;
};
