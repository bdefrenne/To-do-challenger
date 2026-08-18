/**
 * A stable number per object identity.
 *
 * For building a dependency signature out of things you can only compare by
 * reference. React memo deps have to be primitives, but "did any of these 7 task
 * objects get replaced?" is an identity question — so map each object to a number
 * once and join them: same references ⇒ same string ⇒ the memo holds.
 *
 * A WeakMap, so an entry disappears with the object it describes and this can't
 * leak across a long session.
 */
const ids = new WeakMap<object, number>();
let next = 1;

export function refId(o: object): number {
  let id = ids.get(o);
  if (id === undefined) {
    id = next++;
    ids.set(o, id);
  }
  return id;
}
