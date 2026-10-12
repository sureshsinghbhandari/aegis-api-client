/**
 * Registers the HAR, Insomnia, Postman v1 and Postman data-dump importers with
 * the document-import registry so `importDocument()` can dispatch to them.
 * Imported for its side effect from index.ts.
 */
import type { ImportedDocuments } from './import-document';
import { registerDocumentImporter, singleCollection } from './import-document';
import { parsePostmanDump } from './import-dump';
import { parseHar } from './import-har';
import { parseInsomnia } from './import-insomnia';
import { parsePostmanV1 } from './import-v1';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

registerDocumentImporter('har', (doc, o) => {
  const r = parseHar(doc, { onProgress: o.onProgress, ...(o.fileName ? { name: o.fileName.replace(/\.har(\.json)?$/i, '') } : {}) });
  return singleCollection('har', r, '1.2');
});

registerDocumentImporter('postman-v1', (doc, o) => singleCollection('postman-v1', parsePostmanV1(doc, { onProgress: o.onProgress }), '1.0.0'));

registerDocumentImporter('insomnia', (doc, o): ImportedDocuments => {
  const r = parseInsomnia(doc, { onProgress: o.onProgress });
  const name = r.collections.length === 1 && r.environments.length === 0 ? r.collections[0]!.name : `Insomnia export (${plural(r.collections.length, 'collection')}, ${plural(r.environments.length, 'environment')})`;
  return { format: 'insomnia', name, collections: r.collections, environments: r.environments, globals: null, warnings: r.warnings, stats: r.stats, schemaVersion: '4' };
});

registerDocumentImporter('postman-dump', (doc, o): ImportedDocuments => {
  const r = parsePostmanDump(doc, { onProgress: o.onProgress });
  const name = `Postman data dump (${plural(r.collections.length, 'collection')}, ${plural(r.environments.length, 'environment')}${r.globals ? ', globals' : ''})`;
  return { format: 'postman-dump', name, collections: r.collections, environments: r.environments, globals: r.globals ? r.globals.variables : null, warnings: r.warnings, stats: r.stats, schemaVersion: '1' };
});
