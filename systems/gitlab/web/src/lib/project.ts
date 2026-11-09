import { useParams } from 'react-router';
import { ORG } from './api';

/** `keybank/<group>/<project>` from the current route. */
export function useProjectPath() {
  const { group = '', project = '' } = useParams();
  return { path: `${ORG}/${group}/${project}`, name: project, group };
}
