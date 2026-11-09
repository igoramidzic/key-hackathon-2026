import type { RepoOverlay } from '../types';
import { ABA_REPO, abaOverlay } from './aba';
import { ACH_REPO, achOverlay } from './ach';
import { ATH_REPO, athOverlay } from './ath';
import { BPY_REPO, bpyOverlay } from './bpy';
import { CIF_REPO, cifOverlay } from './cif';
import { CRD_REPO, crdOverlay } from './crd';
import { DEP_REPO, depOverlay } from './dep';
import { FRD_REPO, frdOverlay } from './frd';
import { GLD_REPO, gldOverlay } from './gld';
import { MBL_REPO, mblOverlay } from './mbl';
import { NTF_REPO, ntfOverlay } from './ntf';
import { OLB_REPO, olbOverlay } from './olb';
import { PAY_REPO, payOverlay } from './pay';
import { TLR_REPO, tlrOverlay } from './tlr';
import { WIR_REPO, wirOverlay } from './wir';

/**
 * Culprit repos are complete hand-written codebases; consumer repos layer the classes their
 * stack traces point at over the generated template.
 */
export const overlays: Record<string, RepoOverlay> = {
  // Culprits (complete)
  [CIF_REPO]: cifOverlay,
  [ATH_REPO]: athOverlay,
  [ABA_REPO]: abaOverlay,
  [CRD_REPO]: crdOverlay,
  [TLR_REPO]: tlrOverlay,
  // Consumers (layered)
  [OLB_REPO]: olbOverlay,
  [MBL_REPO]: mblOverlay,
  [PAY_REPO]: payOverlay,
  [FRD_REPO]: frdOverlay,
  [ACH_REPO]: achOverlay,
  [WIR_REPO]: wirOverlay,
  [BPY_REPO]: bpyOverlay,
  [GLD_REPO]: gldOverlay,
  [DEP_REPO]: depOverlay,
  [NTF_REPO]: ntfOverlay,
};
