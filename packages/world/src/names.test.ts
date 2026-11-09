import { describe, expect, it } from 'vitest';
import { drawNames } from '../scripts/names';
import { GENERATED_PEOPLE } from './constants';
import { NAMES } from './names.generated';

describe('names snapshot', () => {
  it('matches seeded Faker (run `pnpm --filter @sim/world gen:names` after changing it)', () => {
    expect(NAMES).toEqual(drawNames(GENERATED_PEOPLE));
  });
});
