import type { TreeNode } from '@aegis/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, ErrorBanner, Field, Modal, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { isInSubtree, planNodeMove } from '../lib/collectionTree';
import { folderOptions } from '../lib/tree-helpers';
import { moveNode } from '../sidebar/treeActions';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import type { ModalComponentProps } from './ModalHost';
import '../styles/collection-ops.css';

/** "Move to…": pick a collection and a folder (or the collection root) for a folder or request. */
export default function MoveToModal({ props }: ModalComponentProps) {
  const kind: 'folder' | 'request' = props?.kind === 'folder' ? 'folder' : 'request';
  const id = typeof props?.id === 'string' ? props.id : '';
  const sourceCollectionId = typeof props?.collectionId === 'string' ? props.collectionId : '';
  const name = typeof props?.name === 'string' ? props.name : '';
  const collections = useApp((s) => s.collections);

  const [collectionId, setCollectionId] = useState(sourceCollectionId);
  const [nodes, setNodes] = useState<TreeNode[] | null>(null);
  const [parentFolderId, setParentFolderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = useCallback(() => useUi.getState().closeModal(), []);

  useEffect(() => {
    let cancelled = false;
    setNodes(null);
    setParentFolderId(null);
    setError(null);
    if (!collectionId) return;
    api.collections
      .tree({ collectionId })
      .then((t) => !cancelled && setNodes(t))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [collectionId]);

  const options = useMemo(() => (nodes ? folderOptions(nodes) : []), [nodes]);
  // A folder cannot move into itself or its own descendants (only possible inside the source collection).
  const disabled = (folderId: string) => kind === 'folder' && collectionId === sourceCollectionId && nodes !== null && isInSubtree(nodes, id, folderId);

  const move = async () => {
    if (!nodes || !id || !collectionId) return;
    const dragged = { id, kind, collectionId: sourceCollectionId };
    const target = parentFolderId ? { id: parentFolderId, kind: 'folder' as const, collectionId } : { id: collectionId, kind: 'collection' as const, collectionId };
    const plan = planNodeMove(nodes, dragged, target, 'inside');
    if (!plan) {
      setError('That destination is not allowed (a folder cannot be moved into itself).');
      return;
    }
    setBusy(true);
    try {
      await moveNode(dragged, plan);
      close();
    } finally {
      setBusy(false);
    }
  };

  const targetName = collections.find((c) => c.id === collectionId)?.name ?? '';
  const cross = collectionId !== sourceCollectionId;
  return (
    <Modal
      title={`Move ${kind}${name ? `: ${name}` : ''}`}
      width={560}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void move()} disabled={busy || !nodes || !id}>
            {busy ? 'Moving…' : 'Move'}
          </Button>
        </>
      }
    >
      {error && <ErrorBanner message={error} />}
      <Field label="Collection">
        <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Folder">
        {nodes === null && !error ? (
          <Spinner label="Loading folders" />
        ) : (
          <div className="mt-folders" role="listbox" aria-label="Destination folder">
            <button type="button" role="option" aria-selected={parentFolderId === null} className={`mt-folder ${parentFolderId === null ? 'selected' : ''}`} onClick={() => setParentFolderId(null)}>
              {targetName || 'Collection'} (root)
            </button>
            {options.map((f) => (
              <button
                key={f.id}
                type="button"
                role="option"
                aria-selected={parentFolderId === f.id}
                className={`mt-folder ${parentFolderId === f.id ? 'selected' : ''}`}
                style={{ paddingLeft: 8 + (f.depth + 1) * 14 }}
                disabled={disabled(f.id) || f.id === id}
                onClick={() => setParentFolderId(f.id)}
              >
                {f.label.split(' / ').pop()}
              </button>
            ))}
          </div>
        )}
      </Field>
      {cross && <p className="fr-note">Moving into another collection: the {kind} keeps its own auth, scripts and variables but will inherit the auth, scripts and variables of "{targetName}" instead of the current collection.</p>}
    </Modal>
  );
}
