/** Small pieces of the interface's English. */

/** A count with its noun: "1 note", "3 notes". */
export const count = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
