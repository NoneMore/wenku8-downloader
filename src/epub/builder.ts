import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import archiver from 'archiver';
import type { Book, Chapter, Volume } from '../domain/book.js';
import { validateBookCompleteness } from '../domain/validate.js';
import { epubImageName } from '../assets/image-store.js';
import { renderChapter, renderCover, renderNavigation, renderVolume } from './render.js';
import { escapeXml, xmlDocument } from './xml.js';

const BOOK_CSS = `
html { color: #111; background: #fff; }
body { font-family: serif; line-height: 1.75; margin: 5%; }
h1, h2, h3 { line-height: 1.35; }
p { margin: 0.65em 0; text-indent: 2em; }
figure { margin: 1.25em 0; text-align: center; }
img { max-width: 100%; max-height: 95vh; object-fit: contain; }
.cover { margin: 0; padding: 0; text-align: center; }
.cover img { width: 100%; height: 100vh; object-fit: contain; }
.volume { text-align: center; margin-top: 30vh; }
.note, .missing-image { color: #666; text-indent: 0; }
`;

export interface EpubBuildOptions {
  allowMissingImages?: boolean;
}

interface TextDocument {
  id: string;
  filename: string;
}

export class EpubBuilder {
  async build(
    book: Book,
    workspaceDirectory: string,
    outputPath: string,
    options: EpubBuildOptions = {},
  ): Promise<string> {
    validateBookCompleteness(book, options.allowMissingImages ?? false);
    const packageDirectory = path.join(workspaceDirectory, 'epub', 'package');
    await rm(packageDirectory, { recursive: true, force: true });
    await Promise.all([
      mkdir(path.join(packageDirectory, 'META-INF'), { recursive: true }),
      mkdir(path.join(packageDirectory, 'EPUB', 'text'), { recursive: true }),
      mkdir(path.join(packageDirectory, 'EPUB', 'images'), { recursive: true }),
      mkdir(path.join(packageDirectory, 'EPUB', 'styles'), { recursive: true }),
      mkdir(path.dirname(outputPath), { recursive: true }),
    ]);

    const chapterFiles = new Map<Chapter, string>();
    const volumeFiles = new Map<Volume, string>();
    const textDocuments: TextDocument[] = [];
    let chapterNumber = 0;
    for (const [volumeIndex, volume] of book.volumes.entries()) {
      const volumeNumber = String(volumeIndex + 1).padStart(4, '0');
      const volumeFilename = `volume-${volumeNumber}.xhtml`;
      volumeFiles.set(volume, volumeFilename);
      textDocuments.push({ id: `volume-${volumeNumber}`, filename: volumeFilename });
      await writeFile(
        path.join(packageDirectory, 'EPUB', 'text', volumeFilename),
        renderVolume(volume),
      );
      for (const chapter of volume.chapters) {
        const filename = `${String(++chapterNumber).padStart(4, '0')}.xhtml`;
        chapterFiles.set(chapter, filename);
        textDocuments.push({ id: `chapter-${chapterNumber}`, filename });
        await writeFile(
          path.join(packageDirectory, 'EPUB', 'text', filename),
          renderChapter(book, chapter),
        );
      }
    }

    for (const asset of book.assets) {
      await copyFile(
        path.join(workspaceDirectory, asset.relativePath),
        path.join(packageDirectory, 'EPUB', 'images', epubImageName(asset)),
      );
    }

    const coverDocument = renderCover(book);
    await Promise.all([
      writeFile(path.join(packageDirectory, 'mimetype'), 'application/epub+zip'),
      writeFile(path.join(packageDirectory, 'META-INF', 'container.xml'), containerXml()),
      writeFile(path.join(packageDirectory, 'EPUB', 'styles', 'book.css'), BOOK_CSS.trim()),
      writeFile(
        path.join(packageDirectory, 'EPUB', 'nav.xhtml'),
        renderNavigation(book, chapterFiles, volumeFiles),
      ),
      writeFile(
        path.join(packageDirectory, 'EPUB', 'package.opf'),
        packageOpf(book, textDocuments, Boolean(coverDocument)),
      ),
      ...(coverDocument
        ? [writeFile(path.join(packageDirectory, 'EPUB', 'cover.xhtml'), coverDocument)]
        : []),
    ]);

    await verifyPackageReferences(packageDirectory, book, textDocuments);
    const temporaryOutput = `${outputPath}.part-${process.pid}`;
    await createArchive(packageDirectory, temporaryOutput);
    await rename(temporaryOutput, outputPath);
    return outputPath;
  }
}

function containerXml(): string {
  return xmlDocument(`<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
}

function packageOpf(book: Book, textDocuments: TextDocument[], hasCover: boolean): string {
  const identifier = `urn:uuid:${randomUUID()}`;
  const assets = book.assets
    .map((asset) => {
      const properties = asset.id === book.coverAssetId ? ' properties="cover-image"' : '';
      return `<item id="asset-${asset.id}" href="images/${escapeXml(epubImageName(asset))}" media-type="${asset.mediaType}"${properties}/>`;
    })
    .join('\n    ');
  const documents = textDocuments
    .map(
      ({ id, filename }) =>
        `<item id="${escapeXml(id)}" href="text/${escapeXml(filename)}" media-type="application/xhtml+xml"/>`,
    )
    .join('\n    ');
  const spine = textDocuments.map(({ id }) => `<itemref idref="${escapeXml(id)}"/>`).join('\n    ');
  return xmlDocument(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escapeXml(book.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${identifier}</dc:identifier>
    <dc:title>${escapeXml(book.title)}</dc:title><dc:creator>${escapeXml(book.author)}</dc:creator>
    <dc:language>${escapeXml(book.language)}</dc:language><dc:description>${escapeXml(book.description)}</dc:description>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles/book.css" media-type="text/css"/>
    ${hasCover ? '<item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>' : ''}
    ${documents}
    ${assets}
  </manifest>
  <spine>${hasCover ? '<itemref idref="cover-page" linear="no"/>' : ''}
    ${spine}
  </spine>
</package>`);
}

async function createArchive(packageDirectory: string, outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append('application/epub+zip', {
      name: 'mimetype',
      store: true,
    });
    archive.directory(path.join(packageDirectory, 'META-INF'), 'META-INF');
    archive.directory(path.join(packageDirectory, 'EPUB'), 'EPUB');
    void archive.finalize();
  });
}

async function verifyPackageReferences(
  packageDirectory: string,
  book: Book,
  textDocuments: TextDocument[],
): Promise<void> {
  for (const { filename } of textDocuments) {
    const content = await readFile(path.join(packageDirectory, 'EPUB', 'text', filename), 'utf8');
    for (const match of content.matchAll(/<img[^>]+src="\.\.\/images\/([^"]+)"/g)) {
      const filename = match[1];
      if (!filename) continue;
      await readFile(path.join(packageDirectory, 'EPUB', 'images', filename));
    }
  }
  if (book.assets.some((asset) => !asset.mediaType.startsWith('image/'))) {
    throw new Error('EPUB 资源清单包含非图片资产');
  }
}
