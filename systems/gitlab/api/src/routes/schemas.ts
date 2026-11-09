import { pageQuery } from '@sim/api-kit';
import { z } from 'zod';

export const labelsSchema = z.union([z.array(z.string()), z.string()]).optional();

export const fileEditSchema = z.object({
  path: z.string().min(1),
  content: z.string().optional(),
  find: z.string().optional(),
  replace: z.string().optional(),
});

const bool = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => v === true || v === 'true' || v === '1');

export const pageSchema = z.object(pageQuery);

export const projectsQuery = z.object({
  ...pageQuery,
  search: z.string().optional(),
  tla: z.string().optional(),
  stack: z.string().optional(),
  kind: z.string().optional(),
  order_by: z.enum(['last_activity_at', 'name', 'id', 'created_at']).default('last_activity_at'),
  sort: z.enum(['asc', 'desc']).optional(),
});

export const commitsQuery = z.object({
  ...pageQuery,
  ref_name: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  author: z.string().optional(),
  path: z.string().optional(),
  with_stats: bool,
  first_parent: bool,
});

export const mrsQuery = z.object({
  ...pageQuery,
  state: z.enum(['opened', 'closed', 'merged', 'all']).default('all'),
  tla: z.string().optional(),
  labels: z.string().optional(),
  author: z.string().optional(),
  merged_after: z.string().optional(),
  merged_before: z.string().optional(),
  updated_after: z.string().optional(),
  created_after: z.string().optional(),
  search: z.string().optional(),
  order_by: z.enum(['created_at', 'updated_at', 'merged_at']).optional(),
  sort: z.enum(['asc', 'desc']).default('desc'),
});

export const createCommitBody = z.object({
  branch: z.string().min(1),
  start_branch: z.string().optional(),
  commit_message: z.string().min(1),
  author: z.string().optional(),
  actions: z
    .array(
      z.object({
        action: z.enum(['create', 'update']),
        file_path: z.string().min(1),
        content: z.string(),
      }),
    )
    .min(1),
});

export const createMrBody = z.object({
  source_branch: z.string().min(1),
  target_branch: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  labels: labelsSchema,
  author: z.string().optional(),
  changes: z.array(fileEditSchema).optional(),
  commit_message: z.string().optional(),
});

export const updateMrBody = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  labels: labelsSchema,
  add_labels: labelsSchema,
  remove_labels: labelsSchema,
  state_event: z.enum(['close', 'reopen']).optional(),
  actor: z.string().optional(),
});

export const mergeBody = z.object({
  merged_by: z.string().optional(),
  merge_commit_message: z.string().optional(),
});

export const noteBody = z.object({ body: z.string().min(1), author: z.string().optional() });
export const approveBody = z.object({ username: z.string().optional() });
export const branchBody = z.object({ branch: z.string().min(1), ref: z.string().min(1) });
export const tagBody = z.object({
  tag_name: z.string().min(1),
  ref: z.string().min(1),
  message: z.string().optional(),
  author: z.string().optional(),
});

export const adminMergeBody = z.object({
  project: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  author: z.string().min(1),
  merged_by: z.string().min(1),
  source_branch: z.string().min(1),
  labels: z.array(z.string()).optional(),
  approvers: z.array(z.string()).optional(),
  edits: z.array(fileEditSchema).min(1),
  opened_minutes_ago: z.number().optional(),
  pipeline_status: z.enum(['success', 'failed']).optional(),
});

export const adminCommitBody = z.object({
  project: z.string().min(1),
  message: z.string().min(1),
  author: z.string().min(1),
  edits: z.array(fileEditSchema).min(1),
  branch: z.string().optional(),
});
