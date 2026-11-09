import { en, Faker } from '@faker-js/faker';
import { WORLD_SEED } from '../src/constants';

/**
 * The seeded Faker draws behind every generated person, in the order buildPeople consumes them.
 * Runtime code reads the checked-in snapshot (src/names.generated.ts) instead of loading Faker,
 * which costs ~17 MB of heap; names.test.ts keeps the snapshot honest.
 */
export function drawNames(count: number): [string, string][] {
  const faker = new Faker({ locale: [en] });
  faker.seed(WORLD_SEED);
  return Array.from({ length: count }, () => [faker.person.firstName(), faker.person.lastName()]);
}
