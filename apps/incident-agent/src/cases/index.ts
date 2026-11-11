/**
 * Incident case state machine and duplicate grouping.
 */
export interface IncidentCase {
  id: string;
  incidentNumber?: string;
  culpritTla?: string;
  childIncidents: string[];
  channelId?: string;
  mergeRequestIid?: number;
  changeRequestNumber?: string;
  state: 'detecting' | 'investigating' | 'fixing' | 'verifying' | 'resolved';
}
