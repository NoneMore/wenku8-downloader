import { z } from 'zod';
import type { Book, Chapter, ContentBlock, ImageBlock } from './book.js';
import { sha256 } from './ids.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const coordinate = z.strictObject({
  chapterUrl: z.url(),
  chapterSha256: digest,
  blockIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const illustrationMapSchema = z.strictObject({
  version: z.literal(1),
  bookId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  entries: z.array(
    z.strictObject({
      target: coordinate.extend({ marker: z.string().min(1) }),
      image: coordinate.extend({ sourceUrl: z.url(), assetSha256: digest }),
      evidence: z.strictObject({
        reference: z.string().trim().min(1),
        note: z.string().optional(),
      }),
    }),
  ),
});

export type IllustrationMap = z.infer<typeof illustrationMapSchema>;
export type SourceCoordinate = z.infer<typeof coordinate>;

export function chapterSha256(chapter: Chapter): string {
  const sequence = chapter.blocks.map((block) => {
    if (block.type === 'image') return ['image', block.sourceUrl, block.alt];
    if (block.type === 'separator') return ['separator'];
    return [block.type, block.text, block.level ?? null];
  });
  return sha256(Buffer.from(JSON.stringify(sequence), 'utf8'));
}

export function sourceCoordinateKey(
  position: Pick<SourceCoordinate, 'chapterUrl' | 'blockIndex'>,
): string {
  return JSON.stringify([position.chapterUrl, position.blockIndex]);
}

export function sourceSnapshotSha256(book: Book): string {
  return sha256(
    Buffer.from(
      JSON.stringify(
        book.volumes.map((volume) =>
          volume.chapters.map((chapter) => [chapter.sourceUrl, chapterSha256(chapter)]),
        ),
      ),
      'utf8',
    ),
  );
}

export class IllustrationMapError extends Error {
  constructor(
    readonly code: string,
    readonly entryIndex?: number,
  ) {
    super(`插图映射校验失败：${code}${entryIndex === undefined ? '' : ` (entry ${entryIndex})`}`);
    this.name = 'IllustrationMapError';
  }
}

export function parseIllustrationMap(value: unknown): IllustrationMap {
  const parsed = illustrationMapSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const entryIndex =
      issue?.path[0] === 'entries' && typeof issue.path[1] === 'number' ? issue.path[1] : undefined;
    throw new IllustrationMapError('MAP_INVALID', entryIndex);
  }
  return parsed.data;
}

export interface IllustrationPlan {
  entries: IllustrationMap['entries'];
  emptyImageChapters: Set<string>;
}

// Eligibility is supplied by the site layer; domain code does not interpret site markers.
export function planIllustrationLayout(
  book: Book,
  value: unknown,
  eligibleTargets: ReadonlySet<string>,
): IllustrationPlan {
  const map = parseIllustrationMap(value);
  if (map.bookId !== book.id) throw new IllustrationMapError('BOOK_ID_MISMATCH');
  const chapters = new Map<string, { chapter: Chapter; volumeIndex: number; digest: string }>();
  for (const [volumeIndex, volume] of book.volumes.entries()) {
    for (const chapter of volume.chapters) {
      if (chapters.has(chapter.sourceUrl)) throw new IllustrationMapError('CHAPTER_URL_AMBIGUOUS');
      chapters.set(chapter.sourceUrl, { chapter, volumeIndex, digest: chapterSha256(chapter) });
    }
  }
  const targets = new Set<string>();
  for (const [entryIndex, entry] of map.entries.entries()) {
    const fail = (code: string): never => {
      throw new IllustrationMapError(code, entryIndex);
    };
    const target = chapters.get(entry.target.chapterUrl) ?? fail('TARGET_CHAPTER_MISSING');
    const image = chapters.get(entry.image.chapterUrl) ?? fail('IMAGE_CHAPTER_MISSING');
    if (target.digest !== entry.target.chapterSha256 || image.digest !== entry.image.chapterSha256)
      fail('CHAPTER_CHANGED');
    if (target.volumeIndex !== image.volumeIndex) fail('CROSS_VOLUME');
    const targetKey = sourceCoordinateKey(entry.target);
    if (targets.has(targetKey)) fail('DUPLICATE_TARGET');
    targets.add(targetKey);
    const targetBlock = target.chapter.blocks[entry.target.blockIndex];
    if (
      !eligibleTargets.has(targetKey) ||
      targetBlock?.type !== 'paragraph' ||
      targetBlock.text !== entry.target.marker
    )
      fail('TARGET_MISMATCH');
    const imageBlock = image.chapter.blocks[entry.image.blockIndex];
    if (
      imageBlock?.type !== 'image' ||
      !imageBlock.sourceUrl ||
      imageBlock.sourceUrl !== entry.image.sourceUrl
    )
      fail('IMAGE_MISMATCH');
  }
  return {
    entries: map.entries,
    emptyImageChapters: new Set(
      [...chapters.values()]
        .filter(
          ({ chapter }) =>
            chapter.blocks.some((block) => block.type === 'image') &&
            chapter.blocks.every((block) => block.type === 'image' || block.type === 'separator'),
        )
        .map(({ chapter }) => chapter.sourceUrl),
    ),
  };
}

export function applyIllustrationLayout(book: Book, plan: IllustrationPlan): Book {
  const chapters = new Map(
    book.volumes.flatMap((volume) =>
      volume.chapters.map((chapter) => [chapter.sourceUrl, chapter] as const),
    ),
  );
  const assets = new Map(book.assets.map((asset) => [asset.id, asset]));
  const replacements = new Map<string, ImageBlock>();
  const removals = new Set<string>();
  for (const [entryIndex, entry] of plan.entries.entries()) {
    const image = chapters.get(entry.image.chapterUrl)?.blocks[entry.image.blockIndex];
    const asset = image?.type === 'image' && image.assetId ? assets.get(image.assetId) : undefined;
    if (
      image?.type !== 'image' ||
      !asset ||
      asset.sourceUrl !== entry.image.sourceUrl ||
      asset.sha256 !== entry.image.assetSha256
    ) {
      throw new IllustrationMapError('IMAGE_RESOURCE_CHANGED_OR_MISSING', entryIndex);
    }
    replacements.set(sourceCoordinateKey(entry.target), { ...image });
    removals.add(sourceCoordinateKey(entry.image));
  }
  const result = structuredClone(book);
  for (const volume of result.volumes) {
    for (const chapter of volume.chapters) {
      chapter.blocks = chapter.blocks.flatMap((block, blockIndex): ContentBlock[] => {
        const key = sourceCoordinateKey({ chapterUrl: chapter.sourceUrl, blockIndex });
        if (removals.has(key)) return [];
        return [replacements.get(key) ?? block];
      });
    }
    volume.chapters = volume.chapters.filter(
      (chapter) =>
        !plan.emptyImageChapters.has(chapter.sourceUrl) ||
        chapter.blocks.some((block) => block.type !== 'separator'),
    );
  }
  return result;
}
