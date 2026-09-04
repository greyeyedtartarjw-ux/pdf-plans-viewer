/**
 * Coordinates asynchronous state sources. A token is current only until a
 * newer document load or a local backup import claims authority.
 */
export function createStateAuthority() {
  let generation = 0;
  return {
    claim(): number {
      generation += 1;
      return generation;
    },
    current(): number {
      return generation;
    },
    isCurrent(token: number): boolean {
      return token === generation;
    },
  };
}