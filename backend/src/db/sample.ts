// Keep source passages and reviewed labels together. Labels address whole documents.
export const passages = {
  chunking: {
    name: 'RAG_Best_Practices.txt',
    text: 'Best practices for implementing RAG systems include proper chunking thresholds, overlap configuration, and maintaining up-to-date embeddings.',
  },
  embedding: {
    name: 'Embedding_Models_Comparison.txt',
    text: 'A comprehensive comparison of embedding models across different dimensions demonstrates that text-embedding-3-small balances cost and performance for many workloads.',
  },
  storage: {
    name: 'Vector_Database_Guide.txt',
    text: 'Vector databases are specialized systems designed for similarity search. Selection factors include latency, scalability, filtering, and ecosystem tooling.',
  },
};
type Source = keyof typeof passages;
interface Example {
  question: string;
  answer: string;
  facts: string[];
  grades: Partial<Record<Source, number>>;
}
export const examples: Example[] = [
  {
    question: 'What numeric chunk size is recommended for dense documents?',
    answer: 'The source does not specify a numeric chunk size.',
    facts: [],
    grades: {},
  },
  {
    question:
      'Which embedding model does the comparison say balances cost and performance?',
    answer: 'text-embedding-3-small',
    facts: ['text-embedding-3-small'],
    grades: { embedding: 3 },
  },
  {
    question: 'What are the selection factors listed for a vector database?',
    answer: 'Latency, scalability, filtering, and ecosystem tooling.',
    facts: ['latency', 'scalability', 'filtering', 'ecosystem tooling'],
    grades: { storage: 3 },
  },
  {
    question:
      'What maintenance practice does the RAG guide recommend for embeddings?',
    answer: 'Maintaining up-to-date embeddings.',
    facts: ['maintaining up-to-date embeddings'],
    grades: { chunking: 3 },
  },
  {
    question: 'Which two chunking settings does the RAG guide call out?',
    answer: 'Chunking thresholds and overlap configuration.',
    facts: ['chunking thresholds', 'overlap configuration'],
    grades: { chunking: 3 },
  },
  {
    question: 'Which tradeoff is highlighted in the embedding comparison?',
    answer: 'Cost and performance.',
    facts: ['cost and performance'],
    grades: { embedding: 3 },
  },
  {
    question:
      'Which model balances cost and performance, and what does the guide recommend maintaining?',
    answer:
      'text-embedding-3-small balances cost and performance. Keep embeddings up to date.',
    facts: [
      'text-embedding-3-small balances cost and performance',
      'maintaining up-to-date embeddings',
    ],
    grades: { embedding: 3, chunking: 2 },
  },
  {
    question:
      'What capability besides similarity search is listed for selecting a vector database?',
    answer: 'Filtering.',
    facts: ['filtering'],
    grades: { storage: 3 },
  },
  {
    question: 'What operation are vector databases designed for?',
    answer: 'Similarity search.',
    facts: ['similarity search'],
    grades: { storage: 3 },
  },
  {
    question:
      'Which ecosystem consideration matters when choosing a vector database?',
    answer: 'Ecosystem tooling.',
    facts: ['ecosystem tooling'],
    grades: { storage: 3 },
  },
];
