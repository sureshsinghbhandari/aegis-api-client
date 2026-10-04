import { lazy, Suspense, type ComponentType } from 'react';
import { useUi, type ModalId } from '../store/ui';

export interface ModalComponentProps {
  props?: Record<string, unknown>;
}

/** Each modal component renders its own <Modal> and closes itself with `useUi.getState().closeModal()`. */
const REGISTRY: Record<ModalId, React.LazyExoticComponent<ComponentType<ModalComponentProps>>> = {
  settings: lazy(() => import('./SettingsModal')),
  environments: lazy(() => import('./EnvironmentsModal')),
  import: lazy(() => import('./ImportModal')),
  export: lazy(() => import('./ExportModal')),
  runner: lazy(() => import('./RunnerModal')),
  search: lazy(() => import('./SearchModal')),
  about: lazy(() => import('./AboutModal')),
  workspaces: lazy(() => import('./WorkspacesModal')),
  'collection-edit': lazy(() => import('./CollectionEditModal')),
  backup: lazy(() => import('./BackupModal')),
};

export function ModalHost() {
  const modal = useUi((s) => s.modal);
  if (!modal) return null;
  const Component = REGISTRY[modal.id];
  return (
    <Suspense fallback={null}>
      <Component key={modal.id} {...(modal.props ? { props: modal.props } : {})} />
    </Suspense>
  );
}
