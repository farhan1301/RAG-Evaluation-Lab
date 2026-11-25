export interface ParsedTaskCsvRow {
  question: string;
  expectedAnswer: string;
  acceptanceRule: string;
}

export interface ParseTaskCsvResult {
  tasks: ParsedTaskCsvRow[];
  warnings: string[];
}

type TaskCsvField = keyof ParsedTaskCsvRow;

const HEADER_ALIASES: Record<string, TaskCsvField> = {
  question: 'question',
  'question text': 'question',
  prompt: 'question',
  'expected answer': 'expectedAnswer',
  'expected result': 'expectedAnswer',
  answer: 'expectedAnswer',
  'ground truth': 'expectedAnswer',
  'acceptance rule': 'acceptanceRule',
  'acceptance criteria': 'acceptanceRule',
  'success criteria': 'acceptanceRule',
  'pass criteria': 'acceptanceRule',
};

const normalizeHeader = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ');

const hasMeaningfulContent = (cells: string[]) =>
  cells.some((cell) => cell.trim().length > 0);

const parseCsv = (content: string): string[][] => {
  const rows: string[][] = [];
  let currentValue = '';
  let currentRow: string[] = [];
  let insideQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (insideQuotes) {
      if (char === '"') {
        const nextChar = content[index + 1];
        if (nextChar === '"') {
          currentValue += '"';
          index += 1;
        } else {
          insideQuotes = false;
        }
      } else {
        currentValue += char;
      }
      continue;
    }

    if (char === '"') {
      insideQuotes = true;
      continue;
    }

    if (char === ',') {
      currentRow.push(currentValue);
      currentValue = '';
      continue;
    }

    if (char === '\r' || char === '\n') {
      currentRow.push(currentValue);
      currentValue = '';

      if (char === '\r' && content[index + 1] === '\n') {
        index += 1;
      }

      rows.push(currentRow);
      currentRow = [];
      continue;
    }

    currentValue += char;
  }

  if (insideQuotes) {
    throw new Error('Unterminated quoted field detected in CSV.');
  }

  if (currentValue.length > 0 || currentRow.length > 0) {
    currentRow.push(currentValue);
  }

  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return rows;
};

export const parseTaskCsv = (rawContent: string): ParseTaskCsvResult => {
  const content = rawContent.replace(/^\uFEFF/, '');
  const rows = parseCsv(content).filter(hasMeaningfulContent);

  if (rows.length === 0) {
    throw new Error('CSV file is empty.');
  }

  const [rawHeaderRow, ...dataRows] = rows;
  const headerPositions: Partial<Record<TaskCsvField, number>> = {};

  rawHeaderRow.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    const mappedField = HEADER_ALIASES[normalized];

    if (
      mappedField !== undefined &&
      headerPositions[mappedField] === undefined
    ) {
      headerPositions[mappedField] = index;
    }
  });

  const questionIndex = headerPositions.question;
  if (questionIndex === undefined) {
    throw new Error('CSV is missing the "question" column header.');
  }

  const expectedAnswerIndex = headerPositions.expectedAnswer;
  if (expectedAnswerIndex === undefined) {
    throw new Error('CSV is missing the "expected_answer" column header.');
  }

  const acceptanceRuleIndex = headerPositions.acceptanceRule;
  if (acceptanceRuleIndex === undefined) {
    throw new Error('CSV is missing the "acceptance_rule" column header.');
  }

  const warnings: string[] = [];
  const tasks: ParsedTaskCsvRow[] = [];

  dataRows.forEach((row, index) => {
    const rowNumber = index + 2;
    const question = (row[questionIndex] ?? '').trim();
    const expectedAnswer = (row[expectedAnswerIndex] ?? '').trim();
    const acceptanceRule = (row[acceptanceRuleIndex] ?? '').trim();

    if (!question && !expectedAnswer && !acceptanceRule) {
      return;
    }

    if (!question || !expectedAnswer || !acceptanceRule) {
      warnings.push(
        `Row ${rowNumber}: missing ${[
          !question ? 'question' : null,
          !expectedAnswer ? 'expected answer' : null,
          !acceptanceRule ? 'acceptance rule' : null,
        ]
          .filter(Boolean)
          .join(', ')}.`,
      );
      return;
    }

    tasks.push({
      question,
      expectedAnswer,
      acceptanceRule,
    });
  });

  if (tasks.length === 0) {
    throw new Error('No valid tasks found in the CSV file.');
  }

  return {
    tasks,
    warnings,
  };
};
