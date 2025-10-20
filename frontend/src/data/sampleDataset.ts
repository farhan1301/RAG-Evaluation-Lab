export interface SampleDatasetDocument {
  id: string;
  name: string;
  source: string;
  content: string;
}

export interface SampleDatasetTask {
  id: string;
  question: string;
  expectedAnswer: string;
  acceptanceRule: string;
}

export interface SampleDataset {
  name: string;
  description: string;
  documents: SampleDatasetDocument[];
  tasks: SampleDatasetTask[];
}

export const sampleDataset: SampleDataset = {
  name: 'Wikipedia – Computing Pioneers',
  description:
    'Five short encyclopedic passages about early computing figures and innovations, paired with factual evaluation questions.',
  documents: [
    {
      id: 'doc-ada-lovelace',
      name: 'Ada_Lovelace.txt',
      source: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
      content: [
        'Ada Lovelace (1815–1852) was an English mathematician and writer who collaborated with Charles Babbage on his Analytical Engine.',
        'She translated Luigi Menabrea’s description of the engine and appended extensive notes that explored how the machine could manipulate symbols and follow general-purpose instructions.',
        'Within these notes she outlined an algorithm for computing Bernoulli numbers, later cited as the first published computer program.',
      ].join('\n\n'),
    },
    {
      id: 'doc-alan-turing',
      name: 'Alan_Turing.txt',
      source: 'https://en.wikipedia.org/wiki/Alan_Turing',
      content: [
        'Alan Turing (1912–1954) was a British mathematician whose 1936 paper introduced the concept of a universal computing machine capable of simulating any algorithm.',
        'During the Second World War he helped lead codebreaking efforts at Bletchley Park, devising statistical techniques and designing improvements to the electromechanical Bombe to break German Enigma traffic.',
        'Turing later addressed the foundations of artificial intelligence and proposed the imitation game, now known as the Turing test, as a measure for machine intelligence.',
      ].join('\n\n'),
    },
    {
      id: 'doc-grace-hopper',
      name: 'Grace_Hopper.txt',
      source: 'https://en.wikipedia.org/wiki/Grace_Hopper',
      content: [
        'Grace Hopper (1906–1992) was an American computer scientist and United States Navy rear admiral who worked on the Harvard Mark I electromechanical computer.',
        'She championed machine-independent programming languages, leading the development of Flow-Matic, which demonstrated that programmers could issue instructions with English-like syntax.',
        'Hopper popularized the term “debugging” after removing an actual moth from the Mark II, and she became a key advocate for COBOL adoption in business computing.',
      ].join('\n\n'),
    },
    {
      id: 'doc-analytical-engine',
      name: 'Analytical_Engine.txt',
      source: 'https://en.wikipedia.org/wiki/Analytical_Engine',
      content: [
        'The Analytical Engine was a nineteenth-century design for a mechanical, general-purpose computer proposed by Charles Babbage as a successor to his Difference Engine.',
        'Its architecture separated a central processing “mill” from a “store” of memory, and it drew control instructions from punched cards inspired by Jacquard looms.',
        'Although never built, the design anticipated conditional branching, looping, and other ideas fundamental to modern programmable machines.',
      ].join('\n\n'),
    },
    {
      id: 'doc-cobol',
      name: 'COBOL.txt',
      source: 'https://en.wikipedia.org/wiki/COBOL',
      content: [
        'COBOL (Common Business-Oriented Language) is a high-level programming language that emerged in 1959 for business data processing.',
        'The language adopted an English-like syntax to make programs more readable to managers and analysts, focusing on records, files, and decimal arithmetic.',
        'Its design was influenced by Grace Hopper’s Flow-Matic language, and COBOL remains in use for core financial and administrative systems decades after its creation.',
      ].join('\n\n'),
    },
  ],
  tasks: [
    {
      id: 'sample-task-1',
      question:
        'Which mathematician in the corpus is credited with publishing the first computer algorithm, and for which machine was it written?',
      expectedAnswer:
        'Ada Lovelace published an algorithm for Charles Babbage’s Analytical Engine.',
      acceptanceRule: 'Must mention Ada Lovelace and the Analytical Engine.',
    },
    {
      id: 'sample-task-2',
      question:
        'Summarize Alan Turing’s role in Allied cryptanalysis during the Second World War.',
      expectedAnswer:
        'Turing led Bletchley Park codebreaking work, refining the Bombe to decrypt Enigma traffic.',
      acceptanceRule: 'Must mention Turing and either Bletchley Park, Enigma, or the Bombe.',
    },
    {
      id: 'sample-task-3',
      question:
        'List two architectural features of the Analytical Engine that anticipated modern computers.',
      expectedAnswer:
        'It separated a processing mill from a memory store and used punched cards for control, enabling conditional branching and loops.',
      acceptanceRule:
        'Must mention any two of: mill, store, punched cards, conditional branching, or loops.',
    },
    {
      id: 'sample-task-4',
      question:
        'Describe how Grace Hopper influenced the design of COBOL according to the documents.',
      expectedAnswer:
        'Her Flow-Matic language inspired COBOL’s English-like syntax and focus on business data processing.',
      acceptanceRule: 'Must mention Grace Hopper and Flow-Matic or COBOL.',
    },
    {
      id: 'sample-task-5',
      question:
        'Which concept introduced by Alan Turing is used to evaluate machine intelligence?',
      expectedAnswer: 'The Turing test, also called the imitation game.',
      acceptanceRule: 'Must mention the Turing test or imitation game.',
    },
  ],
};
