import type { PipelineChunkingConfig, ChunkingStrategy } from '../types/pipeline';

export interface ParsedDocument {
  id: string;
  name?: string;
  source?: string;
  content: string;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  documentName?: string;
  documentSource?: string;
  strategy: ChunkingStrategy;
  index: number;
  content: string;
  charCount: number;
  tokenEstimate: number;
}

export interface DocumentChunkGroup {
  documentId: string;
  documentName?: string;
  documentSource?: string;
  strategy: ChunkingStrategy;
  chunks: DocumentChunk[];
}

const MIN_CHUNK_SIZE = 50;
const MAX_STRATEGY_OVERSHOOT_RATIO = 1.15;

const normalizeNewlines = (text: string) => text.replace(/\r\n?/g, '\n');

const sanitizeChunk = (chunk: string) => chunk.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

const estimateTokens = (content: string) => Math.max(1, Math.round(content.length / 4));

const getSafeChunkSize = (config: PipelineChunkingConfig) =>
  Math.max(MIN_CHUNK_SIZE, Math.floor(config.chunkSize || MIN_CHUNK_SIZE));

const getSafeOverlap = (config: PipelineChunkingConfig, size: number) => {
  const overlap = Math.floor(config.overlap || 0);
  if (overlap <= 0) {
    return 0;
  }
  return Math.min(overlap, Math.floor(size / 2));
};

const generateChunkId = (documentId: string, index: number) =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${documentId}-chunk-${index}`;

const splitIntoSentences = (text: string): string[] => {
  const cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/\s([,;:])/g, '$1')
    .trim();

  if (!cleaned) {
    return [];
  }

  return cleaned
    .split(/(?<=[\.!?])\s+(?=[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
};

const recursiveChunk = (content: string, config: PipelineChunkingConfig): string[] => {
  const size = getSafeChunkSize(config);
  const overlap = getSafeOverlap(config, size);
  const normalized = sanitizeChunk(content);

  if (!normalized) {
    return [];
  }

  const results: string[] = [];
  let start = 0;
  const length = normalized.length;

  while (start < length) {
    const end = Math.min(length, start + size);
    const chunk = sanitizeChunk(normalized.slice(start, end));

    if (chunk) {
      results.push(chunk);
    }

    if (end >= length) {
      break;
    }

    start = end - overlap;

    if (start <= 0) {
      start = end;
    }
  }

  return results;
};

const semanticChunk = (content: string, config: PipelineChunkingConfig): string[] => {
  const size = getSafeChunkSize(config);
  const sentences = splitIntoSentences(content);

  if (sentences.length === 0) {
    return recursiveChunk(content, config);
  }

  const chunks: string[] = [];
  let buffer = '';

  const pushBuffer = () => {
    const cleaned = sanitizeChunk(buffer);
    if (cleaned) {
      chunks.push(cleaned);
    }
    buffer = '';
  };

  const handleOversizedSentence = (sentence: string) => {
    const slices = recursiveChunk(sentence, { ...config, overlap: Math.min(config.overlap, Math.floor(size / 4)) });
    for (const slice of slices) {
      const cleaned = sanitizeChunk(slice);
      if (cleaned) {
        chunks.push(cleaned);
      }
    }
  };

  for (const sentence of sentences) {
    const candidate = buffer ? `${buffer} ${sentence}` : sentence;
    const candidateLength = candidate.length;

    if (candidateLength <= size * MAX_STRATEGY_OVERSHOOT_RATIO) {
      buffer = candidate;
      continue;
    }

    if (buffer) {
      pushBuffer();
    }

    if (sentence.length > size * MAX_STRATEGY_OVERSHOOT_RATIO) {
      handleOversizedSentence(sentence);
    } else {
      buffer = sentence;
    }
  }

  pushBuffer();

  return chunks;
};

const isHeadingLine = (line: string) => {
  if (!line) {
    return false;
  }

  if (/^#{1,6}\s+/.test(line)) {
    return true;
  }

  if (line.endsWith(':')) {
    return true;
  }

  if (/^[A-Z][A-Z0-9\s/&-]{3,}$/.test(line)) {
    return true;
  }

  if (/^\d+[\.)]\s+/.test(line)) {
    return true;
  }

  if (/^[IVXLCDM]+\.\s+/.test(line)) {
    return true;
  }

  return false;
};

const layoutChunk = (content: string, config: PipelineChunkingConfig): string[] => {
  const size = getSafeChunkSize(config);
  const normalized = normalizeNewlines(content);
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return recursiveChunk(content, config);
  }

  const sections: string[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  const flushSection = () => {
    if (!currentHeading && currentLines.length === 0) {
      return;
    }
    const chunkContent = sanitizeChunk(
      [currentHeading, currentLines.join('\n')]
        .filter(Boolean)
        .join('\n\n')
    );

    if (chunkContent.length <= size * MAX_STRATEGY_OVERSHOOT_RATIO) {
      sections.push(chunkContent);
    } else {
      const overflowed = semanticChunk(chunkContent, config);
      sections.push(...overflowed);
    }

    currentHeading = null;
    currentLines = [];
  };

  for (const line of lines) {
    if (isHeadingLine(line)) {
      flushSection();
      currentHeading = line;
    } else {
      currentLines.push(line);
    }
  }

  flushSection();

  if (sections.length === 0) {
    return recursiveChunk(content, config);
  }

  return sections;
};

const isTableLine = (line: string) => {
  if (!line) {
    return false;
  }

  const hasPipes = line.includes('|') && line.split('|').length >= 3;
  const hasTabs = line.includes('\t');

  if (hasPipes || hasTabs) {
    return true;
  }

  const tightColumns = line
    .split(' ')
    .filter(Boolean)
    .map((token) => token.trim()).length >= 4;

  return tightColumns && /\s{2,}/.test(line);
};

const splitTableRows = (rows: string[], size: number): string[] => {
  if (rows.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferLength = 0;

  const flushBuffer = () => {
    if (buffer.length === 0) {
      return;
    }
    const chunkText = sanitizeChunk(buffer.join('\n'));
    if (chunkText) {
      chunks.push(chunkText);
    }
    buffer = [];
    bufferLength = 0;
  };

  for (const row of rows) {
    const rowLength = row.length + 1;
    if (bufferLength + rowLength <= size || buffer.length === 0) {
      buffer.push(row);
      bufferLength += rowLength;
    } else {
      flushBuffer();
      buffer.push(row);
      bufferLength = rowLength;
    }
  }

  flushBuffer();
  return chunks;
};

const tableChunk = (content: string, config: PipelineChunkingConfig): string[] => {
  const size = getSafeChunkSize(config);
  const normalized = normalizeNewlines(content);
  const lines = normalized.split('\n');

  if (lines.every((line) => !isTableLine(line.trim()))) {
    return semanticChunk(content, config);
  }

  const blocks: Array<{ text: string; isTable: boolean }> = [];
  let buffer: string[] = [];
  let bufferIsTable = false;

  const flushBuffer = () => {
    const text = sanitizeChunk(buffer.join('\n'));
    if (text) {
      blocks.push({ text, isTable: bufferIsTable });
    }
    buffer = [];
    bufferIsTable = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushBuffer();
      continue;
    }

    const tableLine = isTableLine(line);

    if (tableLine !== bufferIsTable && buffer.length > 0) {
      flushBuffer();
    }

    buffer.push(line);
    bufferIsTable = tableLine;
  }

  flushBuffer();

  const chunks: string[] = [];

  for (const block of blocks) {
    if (block.isTable) {
      const rows = block.text.split('\n').map((row) => row.trim()).filter(Boolean);
      const splitRows = splitTableRows(rows, size);
      chunks.push(...splitRows);
      continue;
    }

    if (block.text.length <= size * MAX_STRATEGY_OVERSHOOT_RATIO) {
      chunks.push(block.text);
    } else {
      const split = semanticChunk(block.text, config);
      chunks.push(...split);
    }
  }

  return chunks;
};

const CHUNK_STRATEGY_MAP: Record<ChunkingStrategy, (content: string, config: PipelineChunkingConfig) => string[]> = {
  recursive: recursiveChunk,
  semantic: semanticChunk,
  layout: layoutChunk,
  table: tableChunk,
};

export const chunkDocumentWithConfig = (
  document: ParsedDocument,
  config: PipelineChunkingConfig
): DocumentChunkGroup => {
  const strategy = config.strategy;
  const generator = CHUNK_STRATEGY_MAP[strategy] ?? recursiveChunk;
  const normalizedContent = normalizeNewlines(document.content || '');
  const contentToProcess = normalizedContent.trim();

  if (!contentToProcess) {
    return {
      documentId: document.id,
      documentName: document.name,
      documentSource: document.source,
      strategy,
      chunks: [],
    };
  }

  const rawChunks = generator(contentToProcess, config);
  const deduped = rawChunks.map((chunk) => sanitizeChunk(chunk)).filter(Boolean);

  const chunks = deduped.map<DocumentChunk>((chunk, index) => ({
    id: generateChunkId(document.id, index),
    documentId: document.id,
    documentName: document.name,
    documentSource: document.source,
    strategy,
    index,
    content: chunk,
    charCount: chunk.length,
    tokenEstimate: estimateTokens(chunk),
  }));

  return {
    documentId: document.id,
    documentName: document.name,
    documentSource: document.source,
    strategy,
    chunks,
  };
};

export const chunkDocumentsWithConfig = (
  documents: ParsedDocument[],
  config: PipelineChunkingConfig
): DocumentChunkGroup[] => documents.map((document) => chunkDocumentWithConfig(document, config));

export interface ChunkingStatistics {
  totalChunks: number;
  averageChars: number;
  averageTokens: number;
  maxChunkSize: number;
  minChunkSize: number;
}

export const summarizeChunkGroups = (groups: DocumentChunkGroup[]): ChunkingStatistics => {
  const allChunks = groups.flatMap((group) => group.chunks);

  if (allChunks.length === 0) {
    return {
      totalChunks: 0,
      averageChars: 0,
      averageTokens: 0,
      maxChunkSize: 0,
      minChunkSize: 0,
    };
  }

  const totalChars = allChunks.reduce((acc, chunk) => acc + chunk.charCount, 0);
  const totalTokens = allChunks.reduce((acc, chunk) => acc + chunk.tokenEstimate, 0);
  const maxChunk = Math.max(...allChunks.map((chunk) => chunk.charCount));
  const minChunk = Math.min(...allChunks.map((chunk) => chunk.charCount));

  return {
    totalChunks: allChunks.length,
    averageChars: Math.round(totalChars / allChunks.length),
    averageTokens: Math.round(totalTokens / allChunks.length),
    maxChunkSize: maxChunk,
    minChunkSize: minChunk,
  };
};
