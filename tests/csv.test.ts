import { expect, it } from 'vitest';
import { parseTaskCsv } from '../backend/src/ingestion/taskCsv';

it('imports BOM-prefixed CSV with aliases, quoted fields, embedded newlines, and row warnings', () => {
  const result = parseTaskCsv(
    '\uFEFFPrompt,Ground_Truth,Pass Criteria\r\n"Who, exactly?","A ""fox""\nand cub",Both\r\nMissing,,\r\n',
  );
  expect(result).toEqual({
    tasks: [
      {
        question: 'Who, exactly?',
        expectedAnswer: 'A "fox"\nand cub',
        acceptanceRule: 'Both',
      },
    ],
    warnings: ['Row 3: missing expected answer, acceptance rule.'],
  });
});

it.each([
  ['', 'empty'],
  ['question,answer\nQ,A', 'acceptance_rule'],
  ['question,answer,acceptance_rule\nQ,,', 'No valid tasks'],
  ['"unterminated', 'Unterminated quoted field'],
])('reports invalid CSV input', (input, error) => {
  expect(() => parseTaskCsv(input)).toThrow(error);
});
