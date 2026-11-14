import { useState } from 'react';
import { createPortal } from 'react-dom';
import { WorkspaceFrame } from '../../components/workspace/WorkspaceFrame';
import { useActiveView } from '../../components/workspace/ViewTransition';
import { secondaryViews } from '../../components/navigation/workspaces';
import type { WorkContext } from '../../domain/context';
import type { Project } from '../../domain/workspace';
import type { ResearchBackend } from '../../platform/research';
import { canEditProject } from '../../platform/collaboration';
import type { WorkspaceStore } from '../../stores/workspace';
import { useSidebarSlot } from '../../shell/Sidebar';
import { FileResources, FileWorkspace } from '../files/FileWorkspace';

/** Manuscripts are the project's own .tex and .md files; compiling comes later. */
export function WritingWorkspace({
  project,
  store,
  backend,
  view,
  onView,
  activePath,
  onOpen,
  onContext,
}: {
  project: Project;
  store: WorkspaceStore;
  backend: ResearchBackend;
  view: string;
  onView(view: string): void;
  activePath: string | null | undefined;
  onOpen(path: string | null): void;
  onContext(context: WorkContext): void;
}) {
  const slot = useSidebarSlot();
  const active = useActiveView();
  const [createRequest, setCreateRequest] = useState(0);
  const files = (
    <FileResources
      project={project}
      backend={backend}
      mode="writing"
      view="files"
      activePath={activePath}
      onOpen={(path) => {
        onView('files');
        onOpen(path);
      }}
      onCreate={
        canEditProject(project, 'code')
          ? () => {
              onView('files');
              setCreateRequest((value) => value + 1);
            }
          : undefined
      }
    />
  );
  return (
    <WorkspaceFrame
      label="写作"
      views={secondaryViews.writing}
      view={view}
      onView={onView}
      sidebar={slot ? undefined : files}
      sidebarOpen={!slot}
      onSidebarToggle={() => {}}
      width={240}
    >
      {slot && active ? createPortal(files, slot) : null}
      <FileWorkspace
        project={project}
        store={store}
        backend={backend}
        mode="writing"
        view={view}
        activePath={activePath}
        onActivePathChange={onOpen}
        onContext={onContext}
        createRequest={createRequest}
        onCreateHandled={() => setCreateRequest(0)}
      />
    </WorkspaceFrame>
  );
}
