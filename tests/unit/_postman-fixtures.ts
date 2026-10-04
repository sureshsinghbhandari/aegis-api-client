import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FolderNode, ItemNode, RequestDraft } from '@aegis/core';

const DIR = fileURLToPath(new URL('../fixtures/postman/', import.meta.url));

export function fixtureText(name: string): string {
  return readFileSync(`${DIR}${name}`, 'utf8');
}

export function fixtureJson(name: string): any {
  return JSON.parse(fixtureText(name));
}

/** Walk down `items` by index path and return the node. */
export function nodeAt(items: ItemNode[], ...indexes: number[]): ItemNode {
  let list = items;
  let node: ItemNode | undefined;
  for (const i of indexes) {
    node = list[i];
    if (!node) throw new Error(`no item at index ${i}`);
    list = node.kind === 'folder' ? node.items : [];
  }
  if (!node) throw new Error('empty path');
  return node;
}

export function requestAt(items: ItemNode[], ...indexes: number[]): RequestDraft {
  const node = nodeAt(items, ...indexes);
  if (node.kind !== 'request') throw new Error('not a request');
  return node.request;
}

export function folderAt(items: ItemNode[], ...indexes: number[]): FolderNode {
  const node = nodeAt(items, ...indexes);
  if (node.kind !== 'folder') throw new Error('not a folder');
  return node;
}

/** A minimal valid v2.1 collection wrapper around the given items. */
export function collectionOf(item: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    info: { _postman_id: '11111111-2222-4333-8444-555555555555', name: 'Inline', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item,
    ...extra,
  };
}

export function requestItem(request: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'Inline request', request, response: [], ...extra };
}
