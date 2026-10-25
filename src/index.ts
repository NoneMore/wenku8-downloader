export type {
  Asset,
  Book,
  BookSummary,
  Chapter,
  ContentBlock,
  ImageBlock,
  Volume,
} from './domain/book.js';
export { Downloader } from './service/downloader.js';
export { EpubBuilder } from './epub/builder.js';
export { Wenku8Client } from './site/client.js';
export type { DownloadOptions, DownloadResult } from './service/downloader.js';
export type { IllustrationLayoutReport } from './service/illustration-layout.js';
export { parseIllustrationMap, type IllustrationMap } from './domain/illustration-layout.js';
export {
  inspectIllustrations,
  inspectionExitCode,
  type IllustrationInspectionReport,
} from './service/illustration-inspection.js';
