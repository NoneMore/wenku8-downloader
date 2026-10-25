import type { Book } from '../domain/book.js';
import {
  chapterSha256,
  parseIllustrationMap,
  planIllustrationLayout,
  sourceCoordinateKey,
  sourceSnapshotSha256,
  type IllustrationMap,
  type IllustrationPlan,
  type SourceCoordinate,
} from '../domain/illustration-layout.js';
import { sha256 } from '../domain/ids.js';
import { detectIllustrationMarker } from '../site/illustrations.js';

interface LayoutDiagnostic extends SourceCoordinate {
  volumeIndex: number;
  chapterTitle: string;
  volumeTitle: string;
  code: 'UNMAPPED_SYMBOL' | 'LEGACY_URL_FRAGMENT';
  marker?: string;
}

export interface IllustrationLayoutReport {
  version: 1;
  bookId: number;
  mode: 'references' | 'map';
  sourceSnapshotSha256: string;
  mapSha256: string | null;
  counts: {
    recoveredUrls: number;
    appliedMappings: number;
    unresolvedSymbols: number;
    legacyUrlFragments: number;
  };
  diagnostics: LayoutDiagnostic[];
}

export function prepareIllustrationLayout(
  source: Book,
  map?: IllustrationMap,
): {
  book: Book;
  plan: IllustrationPlan;
  report: IllustrationLayoutReport;
} {
  const book = structuredClone(source);
  const eligibleTargets = new Set<string>();
  const report: IllustrationLayoutReport = {
    version: 1,
    bookId: source.id,
    mode: map ? 'map' : 'references',
    sourceSnapshotSha256: sourceSnapshotSha256(source),
    mapSha256: map ? sha256(Buffer.from(JSON.stringify(parseIllustrationMap(map)))) : null,
    counts: { recoveredUrls: 0, appliedMappings: 0, unresolvedSymbols: 0, legacyUrlFragments: 0 },
    diagnostics: [],
  };
  for (const [volumeIndex, volume] of book.volumes.entries()) {
    for (const chapter of volume.chapters) {
      const digest = chapterSha256(chapter);
      chapter.blocks = chapter.blocks.map((block, blockIndex) => {
        const marker = detectIllustrationMarker(block);
        if (!marker) return block;
        if (marker.kind === 'url') {
          report.counts.recoveredUrls++;
          return { type: 'image', sourceUrl: marker.sourceUrl, alt: '插图' };
        }
        const position = { chapterUrl: chapter.sourceUrl, chapterSha256: digest, blockIndex };
        if (marker.kind === 'symbol') eligibleTargets.add(sourceCoordinateKey(position));
        report.diagnostics.push({
          ...position,
          volumeIndex,
          volumeTitle: volume.title,
          chapterTitle: chapter.title,
          code: marker.kind === 'symbol' ? 'UNMAPPED_SYMBOL' : 'LEGACY_URL_FRAGMENT',
          ...(marker.kind === 'symbol' ? { marker: marker.marker } : {}),
        });
        return block;
      });
    }
  }
  const plan = planIllustrationLayout(
    source,
    map ?? { version: 1, bookId: source.id, entries: [] },
    eligibleTargets,
  );
  const mappedTargets = new Set(plan.entries.map((entry) => sourceCoordinateKey(entry.target)));
  report.diagnostics = report.diagnostics.filter(
    (item) => !mappedTargets.has(sourceCoordinateKey(item)),
  );
  report.counts.appliedMappings = plan.entries.length;
  report.counts.unresolvedSymbols = report.diagnostics.filter(
    (item) => item.code === 'UNMAPPED_SYMBOL',
  ).length;
  report.counts.legacyUrlFragments = report.diagnostics.filter(
    (item) => item.code === 'LEGACY_URL_FRAGMENT',
  ).length;
  return { book, plan, report };
}
