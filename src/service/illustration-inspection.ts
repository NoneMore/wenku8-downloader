import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import type { Chapter } from '../domain/book.js';
import { chapterSha256, type SourceCoordinate } from '../domain/illustration-layout.js';
import { sha256 } from '../domain/ids.js';
import { detectIllustrationMarker } from '../site/illustrations.js';
import { parseCatalogue } from '../site/parser.js';
import { manifestSchema } from '../storage/schema.js';

type InspectionCode =
  | 'WORKSPACE_MISSING'
  | 'MANIFEST_INVALID'
  | 'CATALOGUE_INVALID'
  | 'BOOK_ID_MISMATCH'
  | 'CHAPTER_URL_AMBIGUOUS'
  | 'CHAPTER_INCOMPLETE'
  | 'CHAPTER_MISSING'
  | 'CHAPTER_INVALID'
  | 'IMAGE_SOURCE_MISSING'
  | 'IMAGE_FILE_MISSING'
  | 'IMAGE_FILE_INVALID'
  | 'LEGACY_URL_FRAGMENT';

interface InspectionDiagnostic {
  code: InspectionCode;
  chapterUrl?: string;
  blockIndex?: number;
}

type MarkerRecord = SourceCoordinate &
  ({ kind: 'symbol'; marker: string } | { kind: 'url'; marker: string; sourceUrl: string });

interface ImageRecord extends SourceCoordinate {
  sourceUrl: string | null;
  availability: 'available' | 'unavailable';
  relativePath: string | null;
  assetSha256: string | null;
}

export interface IllustrationInspectionReport {
  version: 1;
  bookId: number;
  status: 'complete' | 'partial' | 'error';
  counts: {
    chaptersExpected: number | null;
    chaptersInspected: number;
    symbolMarkers: number;
    urlMarkers: number;
    imageCandidates: number;
    availableImages: number;
    legacyUrlFragments: number;
  };
  chapters: Array<{
    volumeIndex: number;
    volumeTitle: string;
    chapterUrl: string;
    chapterTitle: string;
    chapterSha256: string;
  }>;
  markers: MarkerRecord[];
  images: ImageRecord[];
  diagnostics: InspectionDiagnostic[];
}

const textBlockSchema = z.object({
  type: z.enum(['paragraph', 'heading', 'note']),
  text: z.string(),
  level: z.number().int().optional(),
});
const chapterSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  title: z.string(),
  sourceUrl: z.string(),
  blocks: z.array(
    z.union([
      textBlockSchema,
      z.object({
        type: z.literal('image'),
        sourceUrl: z.string().nullable(),
        alt: z.string(),
        assetId: z.string().optional(),
      }),
      z.object({ type: z.literal('separator') }),
    ]),
  ),
});

const assetHintsSchema = z.object({
  assets: z.array(z.object({ sourceUrl: z.string(), relativePath: z.string() })),
});

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function within(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

// Reads never go through BookWorkspace.open(), which persists a manifest even for existing books.
export async function inspectIllustrations(
  bookId: number,
  workDirectory: string,
): Promise<IllustrationInspectionReport> {
  const directory = path.resolve(workDirectory, String(bookId));
  const report: IllustrationInspectionReport = {
    version: 1,
    bookId,
    status: 'complete',
    counts: {
      chaptersExpected: null,
      chaptersInspected: 0,
      symbolMarkers: 0,
      urlMarkers: 0,
      imageCandidates: 0,
      availableImages: 0,
      legacyUrlFragments: 0,
    },
    chapters: [],
    markers: [],
    images: [],
    diagnostics: [],
  };
  const fatal = (code: InspectionCode): IllustrationInspectionReport => {
    report.status = 'error';
    report.diagnostics.push({ code });
    return report;
  };
  let realDirectory: string;
  try {
    if (!(await stat(directory)).isDirectory()) return fatal('WORKSPACE_MISSING');
    realDirectory = await realpath(directory);
  } catch (error) {
    return fatal(isMissing(error) ? 'WORKSPACE_MISSING' : 'MANIFEST_INVALID');
  }
  const safePath = async (relative: string): Promise<string> => {
    const target = path.resolve(directory, relative);
    if (!within(directory, target)) throw new Error('Path escapes workspace');
    const actual = await realpath(target);
    if (!within(realDirectory, actual)) throw new Error('Path escapes workspace');
    return target;
  };
  const json = async (relative: string): Promise<unknown> =>
    JSON.parse(await readFile(await safePath(relative), 'utf8')) as unknown;
  let manifest;
  try {
    manifest = manifestSchema.parse(await json('manifest.json'));
  } catch {
    return fatal('MANIFEST_INVALID');
  }
  if (manifest.bookId !== bookId) return fatal('BOOK_ID_MISMATCH');
  let volumes;
  try {
    const catalogue = manifest.resources.catalogue;
    if (
      catalogue?.state !== 'complete' ||
      !catalogue.sourceUrl ||
      !/^https?:$/.test(new URL(catalogue.sourceUrl).protocol)
    )
      return fatal('CATALOGUE_INVALID');
    volumes = parseCatalogue(
      await readFile(await safePath('raw/catalogue.html'), 'utf8'),
      catalogue.sourceUrl,
    );
  } catch {
    return fatal('CATALOGUE_INVALID');
  }
  const allChapters = volumes.flatMap((volume) => volume.chapters);
  report.counts.chaptersExpected = allChapters.length;
  if (new Set(allChapters.map((chapter) => chapter.sourceUrl)).size !== allChapters.length)
    return fatal('CHAPTER_URL_AMBIGUOUS');
  const chapterOrder = new Map(allChapters.map((chapter, index) => [chapter.sourceUrl, index]));
  let hints: z.infer<typeof assetHintsSchema>['assets'] = [];
  try {
    const parsed = assetHintsSchema.safeParse(await json('book.json'));
    if (parsed.success) hints = parsed.data.assets;
  } catch {
    // Derived book.json is optional and never supplies chapter content.
  }
  const resourcePaths = new Map<string, string>();
  for (const resource of Object.values(manifest.resources)) {
    if (
      (resource.kind === 'image' || resource.kind === 'cover') &&
      resource.sourceUrl &&
      resource.relativePath
    )
      resourcePaths.set(resource.sourceUrl, resource.relativePath);
  }
  for (const hint of hints)
    if (!resourcePaths.has(hint.sourceUrl)) resourcePaths.set(hint.sourceUrl, hint.relativePath);
  const inspectedImages = new Map<
    string,
    Promise<{ relativePath: string | null; assetSha256: string | null; code?: InspectionCode }>
  >();
  const inspectImage = (sourceUrl: string) => {
    let inspection = inspectedImages.get(sourceUrl);
    if (inspection) return inspection;
    inspection = (async () => {
      const relative = resourcePaths.get(sourceUrl);
      if (!relative)
        return { relativePath: null, assetSha256: null, code: 'IMAGE_FILE_MISSING' as const };
      let relativePath: string | null = null;
      try {
        const target = path.resolve(directory, relative);
        if (within(directory, target))
          relativePath = path.relative(directory, target).split(path.sep).join('/');
        const data = await readFile(await safePath(relative));
        const metadata = await sharp(data, { animated: true, failOn: 'error' }).metadata();
        if (
          !metadata.width ||
          !metadata.height ||
          !['jpeg', 'png', 'gif'].includes(metadata.format ?? '')
        )
          throw new Error('Invalid normalized image');
        await sharp(data, { animated: true, failOn: 'error' }).stats();
        return { relativePath, assetSha256: sha256(data) };
      } catch (error) {
        return {
          relativePath,
          assetSha256: null,
          code: isMissing(error)
            ? ('IMAGE_FILE_MISSING' as const)
            : ('IMAGE_FILE_INVALID' as const),
        };
      }
    })();
    inspectedImages.set(sourceUrl, inspection);
    return inspection;
  };
  for (const [volumeIndex, volume] of volumes.entries()) {
    for (const expected of volume.chapters) {
      const chapterUrl = expected.sourceUrl;
      const record = manifest.resources[`chapter:${expected.id}`];
      if (record?.state !== 'complete') {
        report.diagnostics.push({ code: 'CHAPTER_INCOMPLETE', chapterUrl });
        continue;
      }
      let chapter: Chapter;
      try {
        chapter = chapterSchema.parse(await json(`chapters/${expected.id}.json`)) as Chapter;
        if (chapter.id !== expected.id || chapter.sourceUrl !== chapterUrl)
          throw new Error('Chapter identity mismatch');
      } catch (error) {
        report.diagnostics.push({
          code: isMissing(error) ? 'CHAPTER_MISSING' : 'CHAPTER_INVALID',
          chapterUrl,
        });
        continue;
      }
      const digest = chapterSha256(chapter);
      report.chapters.push({
        volumeIndex,
        volumeTitle: volume.title,
        chapterUrl,
        chapterTitle: chapter.title,
        chapterSha256: digest,
      });
      report.counts.chaptersInspected++;
      for (const [blockIndex, block] of chapter.blocks.entries()) {
        const position = { chapterUrl, chapterSha256: digest, blockIndex };
        const marker = detectIllustrationMarker(block);
        if (marker?.kind === 'fragment') {
          report.counts.legacyUrlFragments++;
          report.diagnostics.push({ code: 'LEGACY_URL_FRAGMENT', chapterUrl, blockIndex });
        } else if (marker) {
          report.markers.push({ ...position, ...marker });
          if (marker.kind === 'symbol') report.counts.symbolMarkers++;
          else report.counts.urlMarkers++;
        }
        if (block.type !== 'image') continue;
        const inspection = block.sourceUrl
          ? await inspectImage(block.sourceUrl)
          : { relativePath: null, assetSha256: null, code: 'IMAGE_SOURCE_MISSING' as const };
        report.images.push({
          ...position,
          sourceUrl: block.sourceUrl,
          availability: inspection.assetSha256 ? 'available' : 'unavailable',
          relativePath: inspection.relativePath,
          assetSha256: inspection.assetSha256,
        });
        report.counts.imageCandidates++;
        if (inspection.assetSha256) report.counts.availableImages++;
        if (inspection.code)
          report.diagnostics.push({ code: inspection.code, chapterUrl, blockIndex });
      }
    }
  }
  report.diagnostics.sort(
    (left, right) =>
      (chapterOrder.get(left.chapterUrl ?? '') ?? -1) -
        (chapterOrder.get(right.chapterUrl ?? '') ?? -1) ||
      (left.blockIndex ?? -1) - (right.blockIndex ?? -1) ||
      left.code.localeCompare(right.code, 'en'),
  );
  if (report.diagnostics.length) report.status = 'partial';
  return report;
}

export function inspectionExitCode(report: IllustrationInspectionReport): number {
  return report.status === 'complete' ? 0 : report.status === 'partial' ? 2 : 1;
}
